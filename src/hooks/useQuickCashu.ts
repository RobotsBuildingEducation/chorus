import { useState, useEffect, useCallback } from 'react';
import { CashuMint, CashuWallet, Proof, MintQuoteState } from '@cashu/cashu-ts';
import type { NostrEvent } from 'nostr-tools';

interface Signer {
  signEvent(event: NostrEvent): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, content: string): Promise<string>;
    decrypt(pubkey: string, content: string): Promise<string>;
  };
}

interface User {
  pubkey: string;
  signer: Signer;
}

interface Nostr {
  event(event: NostrEvent): Promise<void>;
  query(filters: any[], opts?: any): Promise<NostrEvent[]>;
}

interface CashuWalletStruct {
  privkey: string;
  mints: string[];
}

const CASHU_EVENT_KINDS = {
  WALLET: 17375,
  TOKEN: 7375,
  ZAP: 9321,
};

const DEFAULT_MINT = 'https://mint.chorus.community';

const RECIPIENT_PUBKEY =
  'ab216c04afb690e0ea069415273801c6fb7469c28de8c101e49eb031c00fe2d7';

/**
 * Standalone hook providing quick Cashu actions.
 * It manages wallet loading, a fixed 10 sat deposit and
 * one-tap zaps to a predefined recipient.
 */
export function useQuickCashu(nostr: Nostr, user: User | null) {
  const [wallet, setWallet] = useState<CashuWalletStruct | null>(null);
  const [proofs, setProofs] = useState<Proof[]>([]);
  const [invoice, setInvoice] = useState<string | null>(null);
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [isCreatingInvoice, setIsCreatingInvoice] = useState(false);

  // Persist proofs in localStorage for session restoration
  useEffect(() => {
    const stored = localStorage.getItem('quickcashu_proofs');
    if (stored) {
      try {
        setProofs(JSON.parse(stored));
      } catch {
        /* ignore */
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('quickcashu_proofs', JSON.stringify(proofs));
  }, [proofs]);

  const loadWallet = useCallback(async () => {
    if (!nostr || !user) return;
    const events = await nostr.query([
      { kinds: [CASHU_EVENT_KINDS.WALLET], authors: [user.pubkey], limit: 1 },
    ]);
    if (events.length === 0) return;
    const event = events[0];
    if (!user.signer.nip44) return;
    const decrypted = await user.signer.nip44.decrypt(user.pubkey, event.content);
    const data = JSON.parse(decrypted) as string[][];
    const privkey = data.find(d => d[0] === 'privkey')?.[1];
    const mints = data.filter(d => d[0] === 'mint').map(d => d[1]);
    if (!privkey) return;
    setWallet({ privkey, mints: mints.length ? mints : [DEFAULT_MINT] });

    // also load proofs stored as token events
    const tokenEvents = await nostr.query([
      { kinds: [CASHU_EVENT_KINDS.TOKEN], authors: [user.pubkey], limit: 100 },
    ]);
    const allProofs: Proof[] = [];
    for (const ev of tokenEvents) {
      try {
        const dec = await user.signer.nip44.decrypt(user.pubkey, ev.content);
        const token = JSON.parse(dec) as { proofs: Proof[] };
        allProofs.push(...token.proofs);
      } catch {
        // ignore malformed tokens
      }
    }
    if (allProofs.length) setProofs(allProofs);
  }, [nostr, user]);

  useEffect(() => {
    loadWallet();
  }, [loadWallet]);

  const deposit10 = useCallback(async () => {
    if (!wallet) throw new Error('Wallet not loaded');
    setIsCreatingInvoice(true);
    try {
      const mint = new CashuMint(wallet.mints[0]);
      const cw = new CashuWallet(mint);
      await cw.loadMint();
      const quote = await cw.createMintQuote(10);
      setInvoice(quote.request);
      setQuoteId(quote.quote);
      return quote.request;
    } finally {
      setIsCreatingInvoice(false);
    }
  }, [wallet]);

  const finalizeDeposit = useCallback(async () => {
    if (!wallet || !quoteId) return false;
    const mint = new CashuMint(wallet.mints[0]);
    const cw = new CashuWallet(mint);
    await cw.loadMint();
    let attempts = 0;
    let status;
    while (attempts < 40) {
      status = await cw.checkMintQuote(quoteId);
      if (status.state === MintQuoteState.PAID) break;
      attempts++;
      await new Promise(res => setTimeout(res, 3000));
    }
    if (status?.state !== MintQuoteState.PAID) return false;
    const newProofs = await cw.mintProofs(10, quoteId);
    setProofs(prev => [...prev, ...newProofs]);
    setQuoteId(null);
    setInvoice(null);
    return true;
  }, [wallet, quoteId]);

  const sendToken = useCallback(
    async (amount: number, p2pkPubkey?: string): Promise<Proof[]> => {
      if (!wallet) throw new Error('Wallet not loaded');
      const mintUrl = wallet.mints[0];
      const mint = new CashuMint(mintUrl);
      const cw = new CashuWallet(mint);
      await cw.loadMint();
      const total = proofs.reduce((s, p) => s + p.amount, 0);
      if (total < amount) throw new Error('Insufficient balance');
      const { keep, send } = await cw.send(amount, proofs, {
        pubkey: p2pkPubkey,
        privkey: wallet.privkey,
      });
      setProofs(keep);
      return send;
    },
    [wallet, proofs],
  );

  const zapRecipient = useCallback(async () => {
    if (!wallet || !user) throw new Error('Missing wallet or user');
    const proofsToSend = await sendToken(10, RECIPIENT_PUBKEY);
    const mintUrl = wallet.mints[0];
    const tags = [
      ...proofsToSend.map(p => ['proof', JSON.stringify(p)]),
      ['u', mintUrl],
      ['p', RECIPIENT_PUBKEY],
    ];
    const event = await user.signer.signEvent({
      kind: CASHU_EVENT_KINDS.ZAP,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    });
    await nostr.event(event);
  }, [wallet, user, sendToken, nostr]);

  const balance = proofs.reduce((sum, p) => sum + p.amount, 0);

  return {
    wallet,
    proofs,
    balance,
    invoice,
    quoteId,
    isCreatingInvoice,
    loadWallet,
    deposit10,
    finalizeDeposit,
    sendToken,
    zapRecipient,
  };
}
