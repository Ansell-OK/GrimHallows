import React from 'react';
import { TopBar } from '@/components/layout/TopBar';
import { errorMessage, getProfile, type ProfileResponse } from '@/lib/api';
import { useWallet } from '@/lib/wallet';
import { CircleUserRound } from 'lucide-react';

function formatAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatStx(value: string | null): string {
  if (value === null) return 'Unavailable';
  const ustx = BigInt(value);
  const whole = ustx / 1_000_000n;
  const fraction = (ustx % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ''} STX`;
}

export default function Profile() {
  const { address } = useWallet();
  const [profile, setProfile] = React.useState<ProfileResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!address) return;
    const controller = new AbortController();
    setError(null);
    getProfile(controller.signal)
      .then(setProfile)
      .catch((cause) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          setError(errorMessage(cause));
        }
      });
    return () => controller.abort();
  }, [address]);

  const stats = [
    ['Dungeons Cleared', profile?.dungeonsCompleted ?? 0],
    ['Jackpots Won', profile?.jackpotsWon ?? 0],
    ['Highest Forge Tier', profile?.highestForgeTier ?? 0],
  ] as const;

  return (
    <div className="relative w-full min-h-full flex flex-col bg-obsidian">
      <TopBar />
      <main className="flex-1 pt-24 px-6 pb-12 max-w-5xl mx-auto w-full">
        <section className="flex flex-col items-center mb-10">
          <div className="w-28 h-28 rounded-full border-4 border-stone bg-obsidian flex items-center justify-center mb-5">
            <CircleUserRound size={64} strokeWidth={1.25} className="text-gray-500" aria-hidden="true" />
          </div>
          <h1 className="text-3xl font-display text-gray-200 mb-2">
            {profile?.identity.displayName ?? (address ? formatAddress(address) : 'Wallet not connected')}
          </h1>
          <div className="text-sm font-ui text-gray-400">
            {profile?.identity.bnsName && profile.identity.displayName !== profile.identity.bnsName
              ? `${profile.identity.bnsName} · `
              : ''}
            {profile?.rank ? `Rank ${profile.rank} · ${profile.score} score` : 'Unranked'}
          </div>
        </section>

        {error && <div className="border border-blood/60 bg-blood/10 p-4 text-sm text-red-200 mb-6">{error}</div>}

        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          {stats.map(([label, value]) => (
            <div key={label} className="bg-stone/20 border border-stone p-6 text-center">
              <div className="text-3xl font-display text-gray-200 mb-2">{value}</div>
              <div className="text-xs font-ui tracking-widest text-gray-500 uppercase">{label}</div>
            </div>
          ))}
        </section>

        <section className="border border-stone p-6 grid grid-cols-1 sm:grid-cols-3 gap-5">
          <div>
            <div className="text-xs font-ui tracking-widest text-gray-500 uppercase mb-2">Wallet Balance</div>
            <div className="text-xl font-display text-stx-accent">{profile ? formatStx(profile.balanceUstx) : 'Loading...'}</div>
          </div>
          <div>
            <div className="text-xs font-ui tracking-widest text-gray-500 uppercase mb-2">Free Clears</div>
            <div className="text-xl font-display text-gray-200">{profile?.freeDungeonsCompleted ?? 0}</div>
          </div>
          <div>
            <div className="text-xs font-ui tracking-widest text-gray-500 uppercase mb-2">Paid Clears</div>
            <div className="text-xl font-display text-gray-200">{profile?.paidDungeonsCompleted ?? 0}</div>
          </div>
        </section>
      </main>
    </div>
  );
}
