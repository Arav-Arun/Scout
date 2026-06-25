// Minimal inline icon set (no external icon dependency). 1.6px stroke, 16px box.

type P = { className?: string };

export const CheckIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const ArrowLeftIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
    <path d="M10 4l-4 4 4 4M6 8h6.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const SpinnerIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
    <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const SendIcon = ({ className }: P) => (
  <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
    <path d="M3 10l14-6-6 14-2.2-5.8L3 10z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const DatabaseIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
    <ellipse cx="8" cy="3.5" rx="5" ry="2" stroke="currentColor" strokeWidth="1.4" />
    <path d="M3 3.5v9c0 1.1 2.2 2 5 2s5-.9 5-2v-9" stroke="currentColor" strokeWidth="1.4" />
    <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

export const SparkIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
    <path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4L8 1.5z" fill="currentColor" />
  </svg>
);

export const ChartIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
    <path d="M2 14h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <rect x="3" y="8" width="2.4" height="4" rx="0.6" fill="currentColor" />
    <rect x="6.8" y="5" width="2.4" height="7" rx="0.6" fill="currentColor" />
    <rect x="10.6" y="3" width="2.4" height="9" rx="0.6" fill="currentColor" />
  </svg>
);

export const PanelLeftIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
    <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" />
    <path d="M6.5 3v10" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

export const PaperclipIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
    <path
      d="M13 7.2l-5.6 5.6a3 3 0 0 1-4.24-4.24l6-6a2 2 0 0 1 2.83 2.83l-5.65 5.65a1 1 0 0 1-1.42-1.42L9.7 5"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const GearIcon = ({ className }: P) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.75" />
    <path
      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const MoonIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
    <path
      d="M13.5 9.4A5.2 5.2 0 0 1 6.6 2.5 5.3 5.3 0 1 0 13.5 9.4z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
);

export const SunIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
    <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M8 1.4v1.5M8 13.1v1.5M1.4 8h1.5M13.1 8h1.5M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </svg>
);

export const CodeIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
    <path d="M5.5 4.5L2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const ShareIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
    <circle cx="12" cy="3.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="4" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="12" cy="12.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5.6 7l4.8-2.6M5.6 9l4.8 2.6" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

export const GraphIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
    <circle cx="3.5" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="12.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="8" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.3" />
    <path d="M4.7 5.2 6.9 10.6M11.4 4.7 9.2 10.6M5 4 11 3.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

export const TrashIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
    <path d="M2.5 4h11M4.5 4V2.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5V4M5.5 7v5M10.5 7v5M3.5 4l1 9.5a1.5 1.5 0 0 0 1.5 1.5h4a1.5 1.5 0 0 0 1.5-1.5l1-9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
