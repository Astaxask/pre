import { View, Text, StyleSheet } from 'react-native';

type ConfidenceBarProps = {
  value: number;
  label?: string;
  accentColor?: string;
  warningColor?: string;
  tertiaryColor?: string;
};

function getConfidenceTier(
  value: number,
  accent: string,
  warning: string,
  tertiary: string,
): { color: string; label: string } {
  if (value >= 0.7) return { color: accent, label: 'Good confidence' };
  if (value >= 0.4) return { color: warning, label: 'Moderate confidence' };
  return { color: tertiary, label: 'Low confidence' };
}

export function ConfidenceBar({
  value,
  label,
  accentColor = '#2D5BE3',
  warningColor = '#B07A00',
  tertiaryColor = '#A8A8A4',
}: ConfidenceBarProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const tier = getConfidenceTier(clamped, accentColor, warningColor, tertiaryColor);
  const displayLabel = label ?? tier.label;
  const percent = Math.round(clamped * 100);

  return (
    <View
      style={styles.container}
      accessibilityRole="progressbar"
      accessibilityValue={{ now: percent, min: 0, max: 100 }}
      accessibilityLabel={displayLabel}
    >
      <View style={styles.labelRow}>
        <Text style={[styles.labelText, { color: '#6B6B68' }]}>{displayLabel}</Text>
        <Text style={[styles.percentText, { color: '#A8A8A4' }]}>{percent}%</Text>
      </View>
      <View style={[styles.track, { backgroundColor: '#EBEBEA' }]}>
        <View
          style={[
            styles.fill,
            {
              width: `${percent}%`,
              backgroundColor: tier.color,
            },
          ]}
          testID="confidence-fill"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 4,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  labelText: {
    fontSize: 12,
    fontWeight: '400',
  },
  percentText: {
    fontSize: 12,
    fontWeight: '400',
  },
  track: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 2,
  },
});
