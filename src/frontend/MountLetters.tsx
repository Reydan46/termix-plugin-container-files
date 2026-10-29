import React from "react";
import { MOUNT_LETTERS as G } from "./mountLookup";

/**
 * "RW" / "RO" drawn on top of a folder icon. It fills the icon's own box
 * (position absolute) so it scales with the icon and takes no layout space.
 * The icon underneath is filled with the mount colour; the letters use the
 * page background colour in dark mode and white in light mode.
 */
export function MountLetters({ label }: { label: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${G.viewBox} ${G.viewBox}`}
      className="pointer-events-none absolute inset-0 size-full"
    >
      <text
        x={G.x}
        y={G.y}
        textAnchor="middle"
        fontSize={G.fontSize}
        fontWeight={800}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        textLength={G.textLength}
        lengthAdjust="spacingAndGlyphs"
        className="fill-white dark:fill-background"
      >
        {label}
      </text>
    </svg>
  );
}

/** Classes that fill a lucide icon inside the wrapper with the mount blue. */
export const MOUNT_ICON_CLASS =
  "[&_svg]:fill-current [&_svg]:text-blue-500 dark:[&_svg]:text-blue-400";
