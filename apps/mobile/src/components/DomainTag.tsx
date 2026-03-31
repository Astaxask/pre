import { Pressable, Text, StyleSheet } from 'react-native';

const DOMAIN_COLORS: Record<string, string> = {
  body: '#1A7F4B',
  money: '#B07A00',
  people: '#7B3FC4',
  time: '#2D5BE3',
  mind: '#C0392B',
  world: '#5A5A56',
};

const DOMAIN_LABELS: Record<string, string> = {
  body: 'Body',
  money: 'Money',
  people: 'People',
  time: 'Time',
  mind: 'Mind',
  world: 'World',
};

type DomainTagProps = {
  domain: string;
  size?: 'sm' | 'md';
  onPress?: () => void;
};

export function DomainTag({ domain, size = 'md', onPress }: DomainTagProps) {
  const color = DOMAIN_COLORS[domain] ?? '#5A5A56';
  const label = DOMAIN_LABELS[domain] ?? domain;
  const isSmall = size === 'sm';

  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={`${label} domain`}
      accessibilityRole="text"
      style={[
        styles.tag,
        {
          backgroundColor: color + '1F', // 12% opacity
          paddingHorizontal: isSmall ? 8 : 10,
          paddingVertical: isSmall ? 2 : 4,
        },
      ]}
      testID={`domain-tag-${domain}`}
    >
      <Text
        style={[
          styles.label,
          {
            color,
            fontSize: isSmall ? 11 : 12,
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tag: {
    borderRadius: 9999,
    alignSelf: 'flex-start',
  },
  label: {
    fontWeight: '500',
  },
});
