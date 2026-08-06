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

export function CharacterCard({ character, selected, onClick, compact, className }: CharacterCardProps) {
  const colorClass = rarityColors[character.rarity];
  
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
      
      {/* Art Placeholder */}
      <div className="absolute inset-0 bg-stone flex items-center justify-center">
        {character.image ? (
          <div className="w-full h-full bg-cover bg-center opacity-70" style={{ backgroundImage: `url(${character.image})` }} />
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
