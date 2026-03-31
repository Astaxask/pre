import { useColorScheme } from 'react-native';
import { lightTokens, darkTokens, type ThemeTokens } from './tokens';

export function useTheme(): ThemeTokens & { isDark: boolean } {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const tokens = isDark ? darkTokens : lightTokens;
  return { ...tokens, isDark };
}
