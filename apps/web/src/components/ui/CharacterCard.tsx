import React from 'react';
import { cn } from '@/lib/utils';
import { motion } from 'motion/react';
import { Heart, Sword, Shield, Zap, Wand2, Crosshair, Crown } from 'lucide-react';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';
export type CharClass = 'warrior' | 'mage' | 'rogue' | 'paladin';

interface Character {
  id: string;
  name: string;
  tokenId: string;
  image?: string;
  rarity: Rarity;
  charClass: CharClass;
  stats: {
    hp: number;
    str: number;
    agi: number;
    int: number;
    vit: number;
  };
}

const rarityColors = {
  common: 'border-gray-500 text-gray-500 shadow-gray-500/20',
  uncommon: 'border-green-500 text-green-500 shadow-green-500/20',
  rare: 'border-blue-500 text-blue-500 shadow-blue-500/20',
  epic: 'border-void text-void shadow-void/40',
  legendary: 'border-gold text-gold shadow-gold/40',
  mythic: 'border-blood text-blood shadow-blood/60',
};

const ClassIcon = ({ charClass, className }: { charClass: CharClass, className?: string }) => {
  switch (charClass) {
    case 'warrior': return <Sword className={className} />;
    case 'mage': return <Wand2 className={className} />;
    case 'rogue': return <Crosshair className={className} />;
    case 'paladin': return <Shield className={className} />;
    default: return <Crown className={className} />;
  }
};

interface CharacterCardProps {
  character: Character;
  selected?: boolean;
  onClick?: () => void;
  compact?: boolean;
  className?: string;
}

/**
 * URLs already reported. A roster re-render, a filter change or a remount would
 * otherwise re-warn for every card every time, which trains you to ignore the
 * warning — the opposite of what a loud failure is for.
 */
const warnedImages = new Set<string>();

function warnImageFailed(url: string, character: Character) {
  if (warnedImages.has(url)) return;
  warnedImages.add(url);
  console.warn(
    `[CharacterCard] Image failed to load for "${character.name}" (token #${character.tokenId}): ${url}\n` +
      'Showing the class-icon placeholder. If this is a wallet-held NFT, check the API ' +
      '/image-proxy response — it names the reason it refused (blocked host, not an image, too large).',
  );
}

export function CharacterCard({ character, selected, onClick, compact, className }: CharacterCardProps) {
  const colorClass = rarityColors[character.rarity];

  // The failed URL rather than a boolean, so the flag clears by itself when the
  // image changes — a mint whose rarity climbs gets a new portrait URL, and that
  // fresh URL deserves its own attempt rather than inheriting the old verdict.
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  const showImage = Boolean(character.image) && failedUrl !== character.image;

  return (
    <motion.div
      whileHover={{ scale: 1.02, y: -4 }}
      onClick={onClick}
      className={cn(
        "relative cursor-pointer bg-stone border-2 overflow-hidden transition-all duration-500",
        colorClass,
        selected ? "ring-2 ring-offset-4 ring-offset-obsidian ring-stx-accent" : "",
        compact ? "w-48 h-72" : "w-64 h-96",
        className
      )}
    >
      <div className="absolute inset-0 bg-gradient-to-t from-obsidian via-obsidian/80 to-transparent z-10" />

      {/* Art, or the class-icon placeholder when there is none or it failed to load. */}
      <div className="absolute inset-0 bg-stone flex items-center justify-center">
        {showImage ? (
          // An <img> rather than a CSS background-image specifically so `onError`
          // exists: a background that 404s fails silently, which is how a broken
          // metadata URL used to reach a player as an empty card with nothing in
          // the console. alt="" because the name and class are rendered as text
          // just below — a screen reader announcing them twice is noise.
          <img
            src={character.image}
            alt=""
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover opacity-70"
            onError={() => {
              const url = character.image;
              if (!url) return;
              warnImageFailed(url, character);
              setFailedUrl(url);
            }}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center bg-obsidian/50 opacity-60">
            <ClassIcon charClass={character.charClass} className="w-20 h-20 mb-4 opacity-50" />
            <div className="text-xs uppercase tracking-widest font-ui opacity-50">{character.charClass}</div>
          </div>
        )}
      </div>

      <div className="absolute inset-0 z-20 flex flex-col justify-end p-4">
        <div className="text-center mb-4">
          <div className="flex items-center justify-center space-x-2 mb-1">
            <ClassIcon charClass={character.charClass} className="w-3 h-3 text-gray-400" />
            <p className="font-ui text-xs text-gray-400 uppercase tracking-widest">{character.charClass}</p>
          </div>
          <h3 className="font-display text-lg text-white mb-0">{character.name}</h3>
          <p className="font-ui text-xs text-gray-400">#{character.tokenId}</p>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs font-ui">
          <div className="flex items-center text-blood"><Heart size={14} className="mr-1" /> {character.stats.hp}</div>
          <div className="flex items-center text-gray-300"><span className="text-[10px] mr-1 text-gray-500">STR</span> {character.stats.str}</div>
          <div className="flex items-center text-gray-300"><Zap size={14} className="mr-1" /> {character.stats.agi}</div>
          <div className="flex items-center text-gray-300"><span className="text-[10px] mr-1 text-gray-500">INT</span> {character.stats.int}</div>
          <div className="flex items-center text-gray-300"><Shield size={14} className="mr-1" /> {character.stats.vit}</div>
          <div className="flex items-center text-gray-300"><span className="text-[10px] mr-1 text-gray-500">VIT</span> {character.stats.vit}</div>
        </div>
        
        <div className={cn("mt-4 text-center text-xs font-display uppercase tracking-widest border-t border-current/20 pt-2", `text-${character.rarity === 'epic' ? 'void' : character.rarity}`)}>
          {character.rarity}
        </div>
      </div>
      
      {/* Card Ornaments */}
      <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-current z-30" />
      <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-current z-30" />
      <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-current z-30" />
      <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-current z-30" />
    </motion.div>
  );
}
