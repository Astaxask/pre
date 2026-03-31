import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useEffect } from 'react';

type GatewayStatusBannerProps = {
  connected: boolean;
};

export function GatewayStatusBanner({ connected }: GatewayStatusBannerProps) {
  const height = useSharedValue(connected ? 0 : 40);

  useEffect(() => {
    height.value = withTiming(connected ? 0 : 40, { duration: 200 });
  }, [connected, height]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: height.value,
    overflow: 'hidden' as const,
    opacity: height.value > 0 ? 1 : 0,
  }));

  return (
    <Animated.View style={[styles.banner, animatedStyle]} testID="gateway-banner">
      <View style={styles.inner}>
        <Text style={styles.text}>
          Reconnecting to PRE…
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#B07A00',
  },
  inner: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'center',
  },
  text: {
    fontSize: 13,
    fontWeight: '500',
    color: '#FFFFFF',
  },
});
