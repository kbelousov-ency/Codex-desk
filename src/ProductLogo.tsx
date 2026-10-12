import './product-logo.css';

export default function ProductLogo({ className = '' }: { className?: string }) {
  const classes = ['brand-mark', 'kuzmich-brand-mark', className].filter(Boolean).join(' ');
  return <div className={classes}><img src={new URL('../electron/kuzmich-logo.svg', import.meta.url).href} width={32} height={32} alt="" aria-hidden="true" /></div>;
}
