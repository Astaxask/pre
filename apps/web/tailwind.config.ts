import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{ts,tsx}',
    './index.html',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    spacing: {
      '0': '0px',
      '1': '4px',
      '2': '8px',
      '3': '12px',
      '4': '16px',
      '6': '24px',
      '8': '32px',
      '12': '48px',
      '16': '64px',
    },
    borderRadius: {
      sm: '4px',
      DEFAULT: '8px',
      card: '12px',
      pill: '9999px',
    },
    fontSize: {
      display: ['28px', { fontWeight: '500', lineHeight: '1.2' }],
      title: ['20px', { fontWeight: '500', lineHeight: '1.3' }],
      heading: ['17px', { fontWeight: '500', lineHeight: '1.4' }],
      body: ['15px', { fontWeight: '400', lineHeight: '1.6' }],
      label: ['13px', { fontWeight: '500', lineHeight: '1.4' }],
      caption: ['12px', { fontWeight: '400', lineHeight: '1.5' }],
      micro: ['11px', { fontWeight: '400', lineHeight: '1.4' }],
    },
    extend: {
      colors: {
        surface: 'var(--color-surface)',
        'surface-raised': 'var(--color-surface-raised)',
        'surface-sunken': 'var(--color-surface-sunken)',
        'text-primary': 'var(--color-text-primary)',
        'text-secondary': 'var(--color-text-secondary)',
        'text-tertiary': 'var(--color-text-tertiary)',
        border: 'var(--color-border)',
        accent: 'var(--color-accent)',
        positive: 'var(--color-positive)',
        negative: 'var(--color-negative)',
        warning: 'var(--color-warning)',
        'neutral-trend': 'var(--color-neutral-trend)',
        'domain-body': '#1A7F4B',
        'domain-money': '#B07A00',
        'domain-people': '#7B3FC4',
        'domain-time': '#2D5BE3',
        'domain-mind': '#C0392B',
        'domain-world': '#5A5A56',
      },
    },
  },
  plugins: [],
};

export default config;
