import React from 'react';

// Countersunk faceplate screw (docs/ui-design.md §1). A few degrees of
// deterministic per-instance rotation so a row of them doesn't look stamped.
const ROTS = [18, -12, 33, 7, -25, 41];

export const Screw = ({ seed = 0, className = '' }: { seed?: number; className?: string }) => (
  <span
    className={`metal-screw ${className}`}
    style={{ '--screw-rot': `${ROTS[seed % ROTS.length]}deg` } as React.CSSProperties}
  />
);
