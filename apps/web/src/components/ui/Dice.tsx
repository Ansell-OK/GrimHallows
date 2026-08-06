import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';
import imgDiceD20 from '@/assets/images/dice_d20_1785809327291.jpg';
import imgDiceD6 from '@/assets/images/dice_d6_1785809341931.jpg';

interface DiceProps {
  /** Which die art to show. */
  type: 'd20' | 'd6';
  /**
   * The face the die lands on. Server-supplied: this is the real roll, derived
   * from the run's committed seed, and the tumble below never changes it.
   */
  target: number;
  /**
   * Faces on the actual die, when it isn't the one the art depicts — powers roll
   * d4 through d10 and all of them borrow the d6 image. Only affects the blur of
   * numbers while rolling; `target` is still where it stops.
   */
  sides?: number;
  isRolling: boolean;
  onRollComplete?: () => void;
  className?: string;
}

export function Dice({ type, target, sides, isRolling, onRollComplete, className }: DiceProps) {
  const [currentValue, setCurrentValue] = useState<number | '?'>('?');
  const faces = sides ?? (type === 'd20' ? 20 : 6);

  useEffect(() => {
    if (isRolling) {
      setCurrentValue('?');
      let rolls = 0;
      const maxRolls = 20;

      const interval = setInterval(() => {
        // Cosmetic only — the frames of a tumbling die. The value that matters
        // is `target`, which the server derived from the committed seed.
        setCurrentValue(Math.floor(Math.random() * faces) + 1);
        rolls++;

        if (rolls >= maxRolls) {
          clearInterval(interval);
          setCurrentValue(target);
          if (onRollComplete) onRollComplete();
        }
      }, 50);

      return () => clearInterval(interval);
    }
  }, [isRolling, target, faces, onRollComplete]);

  const image = type === 'd20' ? imgDiceD20 : imgDiceD6;

  return (
    <motion.div
      animate={isRolling ? { 
        rotateX: [0, 180, 360, 540, 720],
        rotateY: [0, 180, 360, 540, 720],
        rotateZ: [0, 90, 180, 270, 360],
        scale: [1, 1.5, 0.8, 1.2, 1],
        y: [0, -50, 20, -10, 0],
        filter: ['blur(0px)', 'blur(4px)', 'blur(0px)']
      } : { 
        rotateX: 0,
        rotateY: 0,
        rotateZ: 0,
        scale: 1,
        y: 0,
        filter: 'blur(0px)'
      }}
      transition={isRolling ? { 
        duration: 1, 
        ease: "easeInOut",
      } : { 
        type: "spring", stiffness: 300, damping: 15 
      }}
      className={cn("relative flex items-center justify-center text-void drop-shadow-[0_0_15px_rgba(107,47,160,0.5)]", className)}
    >
      <div className="w-full h-full rounded-full overflow-hidden absolute inset-0 mix-blend-screen opacity-50">
         <img src={image} className="w-full h-full object-cover" alt="Dice" />
      </div>
      <div className="absolute font-display font-bold text-gray-200 text-3xl z-10 drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">{currentValue}</div>
    </motion.div>
  );
}
