import React from 'react';

export const VuMeter = ({ level }: { level: number }) => {
  const [clipped, setClipped] = React.useState(false);
  
  React.useEffect(() => {
    if (level > 0) {
      setClipped(true);
      const timer = setTimeout(() => setClipped(false), 500);
      return () => clearTimeout(timer);
    }
  }, [level]);

  const clamped = Math.max(-60, Math.min(10, level));
  const percentage = ((clamped + 60) / 70) * 100;

  // Custom gradient with sharp color stops:
  // Green up to -10dB (71%), Yellow up to 0dB (86%), Orange up to +5dB (93%), Red above +5dB
  const gradientStyle = {
    background: 'linear-gradient(to top, #00cc99 0%, #00cc99 71%, #eab308 71%, #eab308 86%, #f97316 86%, #f97316 93%, #ef4444 93%, #ef4444 100%)',
    opacity: 0.9
  };

  return (
    <div className="flex-1 h-full flex flex-col gap-[2px]">
      <div className={`w-full h-1.5 rounded-sm transition-colors duration-100 ${clipped ? 'bg-red-600 shadow-[0_0_8px_rgba(220,38,38,1)]' : 'bg-[#1a1a1a]'}`} />
      <div className="flex-1 w-full bg-[#0a0a0a] rounded-sm overflow-hidden relative border-r border-[#1a1a1a]">
        <div className="absolute inset-0" style={gradientStyle} />
        <div 
          className="absolute top-0 left-0 right-0 bg-[#0a0a0a] transition-all duration-[150ms] ease-out" 
          style={{ height: `${100 - percentage}%` }}
        />
      </div>
    </div>
  );
};
