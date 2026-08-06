import React from 'react';
import { TopBar } from '@/components/layout/TopBar';
import { CharacterCard, Rarity, CharClass } from '@/components/ui/CharacterCard';
import { Button } from '@/components/ui/Button';
import { TransactionOverlay, TxState } from '@/components/ui/TransactionOverlay';
import { CheckCircle2, MessageSquare } from 'lucide-react';

import imgVoidRevenant from '@/assets/images/char_void_revenant_1785808799517.jpg';
import imgIronTemplar from '@/assets/images/char_iron_templar_1785808812709.jpg';
import imgShadowLurker from '@/assets/images/char_shadow_lurker_1785808824826.jpg';
import imgWardenOfAsh from '@/assets/images/char_warden_of_ash_1785808834991.jpg';
import imgPartyLeaderCrown from '@/assets/images/misc_party_leader_crown_1785809436630.jpg';

/**
 * Placeholder party, pending the party API (Phase 8).
 *
 * The names are NFT display names, not class names — a token is called whatever
 * its collection called it, and its class comes from the collection's contract
 * principal (`SUPPORTED_CLASS_CONTRACTS`). They are paired to match the class
 * table in 01-game-design.md#4a rather than the archetype names they were
 * written against, so the card art, the class badge, and the stat emphasis agree:
 * Warrior leads on STR/VIT, Rogue on AGI, Mage on INT, Paladin on VIT/INT.
 */
const PARTY_MEMBERS = [
  {
    id: '1',
    player: 'Arcanist#9172',
    isLeader: true,
    isReady: true,
    character: {
      id: 'c1', name: 'Void Revenant', tokenId: '1023', image: imgVoidRevenant, rarity: 'epic' as Rarity,
      charClass: 'mage' as CharClass,
      stats: { hp: 108, str: 12, agi: 17, int: 31, vit: 16 }
    }
  },
  {
    id: '2',
    player: 'Stonebreaker#2211',
    isLeader: false,
    isReady: true,
    character: {
      id: 'c2', name: 'Iron Templar', tokenId: '7781', image: imgIronTemplar, rarity: 'legendary' as Rarity,
      charClass: 'warrior' as CharClass,
      stats: { hp: 148, str: 29, agi: 18, int: 12, vit: 27 }
    }
  },
  {
    id: '3',
    player: 'Nyx#8644',
    isLeader: false,
    isReady: true,
    character: {
      id: 'c3', name: 'Shadow Lurker', tokenId: '5552', image: imgShadowLurker, rarity: 'rare' as Rarity,
      charClass: 'rogue' as CharClass,
      stats: { hp: 98, str: 19, agi: 32, int: 15, vit: 17 }
    }
  },
  {
    id: '4',
    player: 'Grim#4450',
    isLeader: false,
    isReady: true,
    character: {
      id: 'c4', name: 'Warden of Ash', tokenId: '3301', image: imgWardenOfAsh, rarity: 'mythic' as Rarity,
      charClass: 'paladin' as CharClass,
      stats: { hp: 172, str: 22, agi: 15, int: 21, vit: 32 }
    }
  }
];

export default function Party() {
  const [txState, setTxState] = React.useState<TxState>('idle');

  const handleEnterDungeon = () => {
    setTxState('failed');
  };

  return (
    <div className="relative w-full h-full flex flex-col bg-obsidian">
      <TopBar />
      {/*
        Party runs are not enabled: the backend answers PARTY_RUNS_NOT_ENABLED
        for any entry carrying a partyId. The overlay is wired to say so rather
        than to simulate a signature and a payment — a mock that renders
        "Payment Confirmed" for a transaction that never existed is the exact
        shape of screen that teaches a player to trust one that isn't real.
        Solo paid entry, which is live, runs through Map.tsx.
      */}
      <TransactionOverlay
        txState={txState}
        title="Enter The Obsidian Spire"
        amountStx="—"
        error={
          'Party runs are not enabled yet. Enter the spire solo from the world map ' +
          'in the meantime — nothing has been charged.'
        }
        onCancel={() => setTxState('idle')}
        onSign={() => setTxState('failed')}
        onRetry={() => setTxState('idle')}
      />

      <div className="flex-1 pt-24 px-12 pb-12 flex space-x-8 max-w-[1600px] mx-auto w-full">
        
        {/* Left Panel */}
        <div className="w-64 flex flex-col justify-between">
          <div>
            <h2 className="text-sm font-ui tracking-[0.2em] text-gray-400 uppercase mb-4">Party</h2>
            <div className="text-2xl font-display text-gray-200 mb-6">Spire Hunters</div>
            
            <div className="space-y-2 text-sm font-ui text-gray-400 mb-8">
              <div className="flex justify-between"><span>Party ID</span> <span className="text-gray-200">67F3A</span></div>
              <div className="flex justify-between"><span>Privacy</span> <span className="text-gray-200">Open</span></div>
            </div>
            
            <div className="space-y-4">
              <Button variant="secondary" className="w-full">Invite Player</Button>
              <Button variant="danger" className="w-full">Leave Party</Button>
            </div>
          </div>
          
          {/* Party Chat */}
          <div className="flex-1 min-h-0 mt-8 flex flex-col border border-stone bg-obsidian/50">
            <div className="p-3 border-b border-stone text-xs font-ui tracking-widest uppercase text-gray-500">Party Chat</div>
            <div className="flex-1 p-4 overflow-y-auto space-y-4 text-xs font-ui">
              <div className="flex space-x-2">
                <MessageSquare size={14} className="text-gray-500 mt-0.5" />
                <div>
                  <span className="text-gray-400 font-medium">Nyx#8644</span>
                  <p className="text-gray-300">Ready when you are.</p>
                </div>
              </div>
              <div className="flex space-x-2">
                <MessageSquare size={14} className="text-gray-500 mt-0.5" />
                <div>
                  <span className="text-gray-400 font-medium">Grim#4450</span>
                  <p className="text-gray-300">Let's claim that spire.</p>
                </div>
              </div>
              <div className="flex space-x-2">
                <MessageSquare size={14} className="text-void mt-0.5" />
                <div>
                  <span className="text-void font-medium">Arcanist#9172</span>
                  <p className="text-gray-300">Pool is looking good today.</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Center Panel */}
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="flex justify-center space-x-6 mb-16">
            {PARTY_MEMBERS.map(member => (
              <div key={member.id} className="flex flex-col items-center">
                <div className="mb-4 text-center flex flex-col items-center h-12">
                  <div className="text-sm font-ui text-gray-200">{member.player}</div>
                  {member.isLeader && <img src={imgPartyLeaderCrown} className="w-5 h-5 mt-1 object-contain" alt="Leader" />}
                </div>
                <CharacterCard character={member.character} compact />
              </div>
            ))}
          </div>

          <div className="flex flex-col items-center">
            <div className="flex items-center space-x-4 mb-2">
              <span className="text-sm font-ui tracking-widest text-gray-300 uppercase">Ready Check</span>
              <div className="flex space-x-2">
                {PARTY_MEMBERS.map(m => <CheckCircle2 key={m.id} size={20} className="text-rot" />)}
              </div>
            </div>
            <div className="text-xs font-ui text-gray-500 mb-8">All members ready</div>
            
            <Button variant="stx" size="lg" className="w-80 flex flex-col" onClick={handleEnterDungeon}>
              <span className="mb-1">Enter Dungeon</span>
              <span className="text-[10px] text-obsidian/70">The Obsidian Spire (1 STX Gate Fee)</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
