import React from 'react';
import { cn } from '@/lib/utils';
import { motion, HTMLMotionProps } from 'motion/react';

interface ButtonProps extends Omit<HTMLMotionProps<"button">, 'children'> {
  variant?: 'primary' | 'secondary' | 'danger' | 'void' | 'stx';
  size?: 'sm' | 'md' | 'lg';
  // motion's own children type admits MotionValue, which can't go inside a
  // plain <span>. Buttons only ever take static content here.
  children?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', children, ...props }, ref) => {
    
    const baseStyles = "relative inline-flex items-center justify-center font-display uppercase tracking-widest transition-all duration-300 overflow-hidden disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none";
    
    const variants = {
      primary: "text-gold border border-gold/30 bg-stone/80 hover:bg-stone hover:border-gold/60 shadow-[0_0_15px_rgba(199,164,134,0.1)] hover:shadow-[0_0_20px_rgba(199,164,134,0.3)]",
      secondary: "text-gray-400 border border-gray-700 bg-obsidian/80 hover:text-gray-200 hover:border-gray-500",
      danger: "text-blood border border-blood/30 bg-blood/10 hover:bg-blood/20 hover:border-blood/60 shadow-[0_0_15px_rgba(122,16,24,0.2)]",
      void: "text-void border border-void/30 bg-void/10 hover:bg-void/20 hover:border-void/60 shadow-[0_0_15px_rgba(107,47,160,0.2)]",
      stx: "text-stx-accent border border-stx-accent/30 bg-stx-accent/10 hover:bg-stx-accent/20 hover:border-stx-accent/60 shadow-[0_0_15px_rgba(33,212,184,0.2)]",
    };
    
    const sizes = {
      sm: "px-4 py-2 text-xs",
      md: "px-8 py-3 text-sm",
      lg: "px-12 py-4 text-base",
    };

    return (
      <motion.button
        ref={ref}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        className={cn(baseStyles, variants[variant], sizes[size], className)}
        {...props}
      >
        <span className="relative z-10">{children}</span>
        {/* Corner accents */}
        <div className="absolute top-0 left-0 w-1.5 h-1.5 border-t border-l border-current opacity-50" />
        <div className="absolute top-0 right-0 w-1.5 h-1.5 border-t border-r border-current opacity-50" />
        <div className="absolute bottom-0 left-0 w-1.5 h-1.5 border-b border-l border-current opacity-50" />
        <div className="absolute bottom-0 right-0 w-1.5 h-1.5 border-b border-r border-current opacity-50" />
      </motion.button>
    );
  }
);
Button.displayName = "Button";
