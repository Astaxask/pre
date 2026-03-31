export type ThemeTokens = {
  // Surfaces
  surface: string;
  surfaceRaised: string;
  surfaceSunken: string;
  // Text
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  // UI
  border: string;
  accent: string;
  positive: string;
  negative: string;
  warning: string;
  neutralTrend: string;
  // Domain colors
  domainBody: string;
  domainMoney: string;
  domainPeople: string;
  domainTime: string;
  domainMind: string;
  domainWorld: string;
};

export const lightTokens: ThemeTokens = {
  surface: '#FFFFFF',
  surfaceRaised: '#F5F5F3',
  surfaceSunken: '#EBEBEA',
  textPrimary: '#1A1A1A',
  textSecondary: '#6B6B68',
  textTertiary: '#A8A8A4',
  border: 'rgba(0,0,0,0.08)',
  accent: '#2D5BE3',
  positive: '#1A7F4B',
  negative: '#C0392B',
  warning: '#B07A00',
  neutralTrend: '#6B6B68',
  domainBody: '#1A7F4B',
  domainMoney: '#B07A00',
  domainPeople: '#7B3FC4',
  domainTime: '#2D5BE3',
  domainMind: '#C0392B',
  domainWorld: '#5A5A56',
};

export const darkTokens: ThemeTokens = {
  surface: '#111111',
  surfaceRaised: '#1C1C1C',
  surfaceSunken: '#0A0A0A',
  textPrimary: '#F0F0EE',
  textSecondary: '#9A9A96',
  textTertiary: '#5A5A56',
  border: 'rgba(255,255,255,0.08)',
  accent: '#4F79FF',
  positive: '#34C77B',
  negative: '#FF5A4A',
  warning: '#F0C040',
  neutralTrend: '#9A9A96',
  domainBody: '#34C77B',
  domainMoney: '#F0C040',
  domainPeople: '#A66DE8',
  domainTime: '#4F79FF',
  domainMind: '#FF5A4A',
  domainWorld: '#9A9A96',
};

export const DOMAIN_COLORS: Record<string, { light: string; dark: string }> = {
  body: { light: '#1A7F4B', dark: '#34C77B' },
  money: { light: '#B07A00', dark: '#F0C040' },
  people: { light: '#7B3FC4', dark: '#A66DE8' },
  time: { light: '#2D5BE3', dark: '#4F79FF' },
  mind: { light: '#C0392B', dark: '#FF5A4A' },
  world: { light: '#5A5A56', dark: '#9A9A96' },
};

export const DOMAIN_LABELS: Record<string, string> = {
  body: 'Body',
  money: 'Money',
  people: 'People',
  time: 'Time',
  mind: 'Mind',
  world: 'World',
};

export const typography = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: '500' as const },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '500' as const },
  heading: { fontSize: 17, lineHeight: 24, fontWeight: '500' as const },
  body: { fontSize: 15, lineHeight: 24, fontWeight: '400' as const },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '500' as const },
  caption: { fontSize: 12, lineHeight: 18, fontWeight: '400' as const },
  micro: { fontSize: 11, lineHeight: 15, fontWeight: '400' as const },
};

export const spacing = {
  sp4: 4,
  sp8: 8,
  sp12: 12,
  sp16: 16,
  sp24: 24,
  sp32: 32,
  sp48: 48,
  sp64: 64,
};

export const radii = {
  subtle: 4,
  default: 8,
  card: 12,
  pill: 9999,
};

export const SEVERITY_COLORS = {
  info: { light: '#2D5BE3', dark: '#4F79FF' },
  warning: { light: '#B07A00', dark: '#F0C040' },
  intervention: { light: '#C0392B', dark: '#FF5A4A' },
};
