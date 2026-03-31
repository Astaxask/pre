import { View, Text, StyleSheet } from 'react-native';

type DistributionRangeProps = {
  p10: number;
  p50: number;
  p90: number;
  unit: string;
  label?: string;
};

export function DistributionRange({ p10, p50, p90, unit, label }: DistributionRangeProps) {
  const range = p90 - p10 || 1;
  const medianPct = ((p50 - p10) / range) * 100;

  const ariaLabel = `${p10} to ${p90} ${unit}, likely ${p50} ${unit}`;

  return (
    <View
      style={styles.container}
      accessibilityLabel={ariaLabel}
      accessibilityRole="summary"
    >
      {label != null && (
        <Text style={styles.label}>{label}</Text>
      )}
      <View style={styles.track}>
        {/* Full range bar */}
        <View style={[styles.rangeBar, { left: '0%', width: '100%' }]} />
        {/* P10 marker */}
        <View style={[styles.marker, { left: '0%' }]} testID="marker-p10" />
        {/* P50 marker (median) */}
        <View style={[styles.medianMarker, { left: `${medianPct}%` }]} testID="marker-p50" />
        {/* P90 marker */}
        <View style={[styles.marker, { left: '100%' }]} testID="marker-p90" />
      </View>
      <View style={styles.valuesRow}>
        <Text style={styles.valueText} testID="p10-value">{p10} {unit}</Text>
        <Text style={[styles.valueText, styles.medianText]} testID="p50-value">{p50} {unit}</Text>
        <Text style={styles.valueText} testID="p90-value">{p90} {unit}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 4,
  },
  label: {
    fontSize: 12,
    color: '#6B6B68',
    fontWeight: '400',
  },
  track: {
    height: 8,
    backgroundColor: '#EBEBEA',
    borderRadius: 4,
    position: 'relative',
  },
  rangeBar: {
    position: 'absolute',
    top: 0,
    height: '100%',
    backgroundColor: 'rgba(45,91,227,0.3)',
    borderRadius: 4,
  },
  marker: {
    position: 'absolute',
    top: 0,
    width: 1,
    height: '100%',
    backgroundColor: 'rgba(107,107,104,0.6)',
  },
  medianMarker: {
    position: 'absolute',
    top: 0,
    width: 2,
    height: '100%',
    backgroundColor: '#2D5BE3',
    borderRadius: 1,
  },
  valuesRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  valueText: {
    fontSize: 11,
    color: '#A8A8A4',
    fontWeight: '400',
  },
  medianText: {
    fontWeight: '500',
    color: '#1A1A1A',
  },
});
