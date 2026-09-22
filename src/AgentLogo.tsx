import type { AgentProvider } from './types';

/** Monochrome agent marks drawn inline: a hexagonal knot for GPT/Codex, a starburst for Claude.
 * Stylized approximations, not the vendors' trademark artwork; they inherit the current text color. */
export default function AgentLogo({ provider, size = 12, className = '' }: { provider: AgentProvider; size?: number; className?: string }) {
  // Decorative: the row/tab text already names the dialog; the agent is exposed via data-agent for tests and tooltips.
  const label = provider === 'claude' ? 'Claude' : 'GPT';
  if (provider === 'claude') {
    // Eight rays of uneven length around a small core.
    const rays = [[0, -11, 0, -4], [8, -8, 3, -3], [11, 0, 4, 0], [8, 8, 3, 3], [0, 11, 0, 4], [-8, 8, -3, 3], [-11, 0, -4, 0], [-8, -8, -3, -3]];
    return <svg className={`agent-logo agent-logo-claude ${className}`} width={size} height={size} viewBox="-12 -12 24 24" aria-hidden="true" focusable="false" data-agent={label}>
      {rays.map(([x1, y1, x2, y2], index) => <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth={index % 2 ? 2 : 2.6} strokeLinecap="round" />)}
    </svg>;
  }
  // Six rounded links rotated by 60°, forming the familiar knot silhouette.
  return <svg className={`agent-logo agent-logo-gpt ${className}`} width={size} height={size} viewBox="-12 -12 24 24" aria-hidden="true" focusable="false" data-agent={label}>
    {[0, 60, 120, 180, 240, 300].map(angle => <rect key={angle} x={-3.2} y={-11} width={6.4} height={13} rx={3.2} fill="none" stroke="currentColor" strokeWidth={1.9} transform={`rotate(${angle})`} />)}
  </svg>;
}
