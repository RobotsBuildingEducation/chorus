import { useNostr } from '@/hooks/useNostr';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useCashuStore } from '@/stores/cashuStore';
import {
  CASHU_EVENT_KINDS,
  activateMint,
  updateMintKeys,
  type CashuWalletStruct,
  defaultMints,
} from '@/lib/cashu';
import { generateSecretKey } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';

export const DEFAULT_MINT = defaultMints[0];

export function useQuickCashu() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const cashuStore = useCashuStore();

  const loadWallet = async (): Promise<void> => {
    if (!user || !nostr) return;

    const events = await nostr.query([
      { kinds: [CASHU_EVENT_KINDS.WALLET], authors: [user.pubkey], limit: 1 }
    ]);

    if (events.length === 0) {
      await initializeWallet();
      return;
    }

    const event = events[0];

    if (!user.signer.nip44) {
      throw new Error('NIP-44 encryption not supported by your signer');
    }

    const decrypted = await user.signer.nip44.decrypt(user.pubkey, event.content);
    let data: string[][] = [];
    try {
      data = JSON.parse(decrypted);
    } catch {
      console.error('Failed to parse wallet data');
      return;
    }

    const privkey = data.find(d => d[0] === 'privkey')?.[1];
    if (!privkey) {
      console.error('Private key not found in wallet data');
      return;
    }

    const mints = data.filter(d => d[0] === 'mint').map(d => d[1]);
    if (!mints.includes(DEFAULT_MINT)) {
      mints.push(DEFAULT_MINT);
    }

    const uniqueMints = [...new Set(mints.map(m => m.replace(/\/$/, '')))] as string[];

    for (const mint of uniqueMints) {
      const { mintInfo, keysets } = await activateMint(mint);
      cashuStore.addMint(mint);
      cashuStore.setMintInfo(mint, mintInfo);
      cashuStore.setKeysets(mint, keysets);
      const { keys } = await updateMintKeys(mint, keysets);
      cashuStore.setKeys(mint, keys);
    }

    cashuStore.setPrivkey(privkey);
    if (!cashuStore.getActiveMintUrl()) {
      cashuStore.setActiveMintUrl(uniqueMints[0]);
    }
  };

  const initializeWallet = async (): Promise<void> => {
    if (!user || !nostr) return;
    if (!user.signer.nip44) {
      throw new Error('NIP-44 encryption not supported by your signer');
    }

    const privkey = bytesToHex(generateSecretKey());
    const walletData: CashuWalletStruct = { privkey, mints: [DEFAULT_MINT] };

    const tags = [
      ['privkey', walletData.privkey],
      ...walletData.mints.map(m => ['mint', m]),
    ];

    const content = await user.signer.nip44.encrypt(
      user.pubkey,
      JSON.stringify(tags)
    );

    const event = await user.signer.signEvent({
      kind: CASHU_EVENT_KINDS.WALLET,
      content,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });

    await nostr.event(event);
    await loadWallet();
  };

  return {
    loadWallet,
    initializeWallet,
  };
}
