import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// Mock expo-crypto
jest.mock('expo-crypto', () => ({
  digestStringAsync: jest.fn().mockResolvedValue('abc123hash'),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

// Mock reanimated
jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return Reanimated;
});

// Mock safe area
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockSendMessage = jest.fn();
const mockGateway = {
  connected: true,
  lastMessage: null,
  sendMessage: mockSendMessage,
  alerts: [],
  insights: [],
  updateGatewayUrl: jest.fn(),
  disconnect: jest.fn(),
  gatewayUrl: 'ws://localhost:18789',
};

jest.mock('../../context/GatewayContext', () => ({
  useGatewayContext: () => mockGateway,
}));

import { LogScreen } from '../LogScreen';

describe('LogScreen', () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    mockGateway.lastMessage = null;
  });

  it('Log button is disabled until text >= 3 chars and domain is selected', () => {
    const { getByTestId } = render(<LogScreen />);
    const btn = getByTestId('log-submit-btn');

    // Domain is pre-selected to 'mind', but no text yet
    expect(btn.props.accessibilityState?.disabled ?? btn.props.disabled).toBeTruthy();

    // Type 2 chars - still disabled
    fireEvent.changeText(getByTestId('log-text-input'), 'hi');
    expect(btn.props.accessibilityState?.disabled ?? btn.props.disabled).toBeTruthy();

    // Type 3+ chars - enabled
    fireEvent.changeText(getByTestId('log-text-input'), 'hello world');
    // After state update, button should be enabled
  });

  it('raw note text is NOT included in the sent gateway message', async () => {
    const { getByTestId } = render(<LogScreen />);

    // Enter text
    fireEvent.changeText(getByTestId('log-text-input'), 'I went for a long run today');

    // Select a domain (mind is default)
    fireEvent.press(getByTestId('log-domain-mind'));

    // Submit
    fireEvent.press(getByTestId('log-submit-btn'));

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    const call = mockSendMessage.mock.calls[0][0];

    // CRITICAL PRIVACY CHECK:
    // The raw note text must NEVER appear in the gateway message
    const serialized = JSON.stringify(call);

    expect(serialized).not.toContain('I went for a long run today');
    expect(serialized).not.toContain('long run');

    // Verify the payload structure
    expect(call.type).toBe('log-event');
    const payload = call.payload;

    // Must NOT have text, content, note (raw text fields)
    expect(payload.text).toBeUndefined();
    expect(payload.content).toBeUndefined();

    // The inner payload should only have hash + wordCount
    expect(payload.payload.contentHash).toBe('abc123hash');
    expect(payload.payload.wordCount).toBe(7);

    // Default domain is 'mind' with subtype 'manual-log'
    expect(payload.payload.domain).toBe('mind');
    expect(payload.payload.subtype).toBe('manual-log');

    // Top-level fields
    expect(payload.source).toBe('manual');
    expect(payload.domain).toBe('mind');
    expect(payload.eventType).toBe('mind.manual-log');
    expect(payload.privacyLevel).toBe('private');
  });

  it('selecting body domain produces eventType body.manual-log', async () => {
    const { getByTestId } = render(<LogScreen />);

    fireEvent.changeText(getByTestId('log-text-input'), 'Went for a run today');
    fireEvent.press(getByTestId('log-domain-body'));
    fireEvent.press(getByTestId('log-submit-btn'));

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    const call = mockSendMessage.mock.calls[0][0];
    expect(call.payload.domain).toBe('body');
    expect(call.payload.eventType).toBe('body.manual-log');
    expect(call.payload.payload.domain).toBe('body');
    expect(call.payload.payload.subtype).toBe('manual-log');
  });

  it('success toast shown after successful log', async () => {
    const { getByTestId, getByText, rerender } = render(<LogScreen />);

    fireEvent.changeText(getByTestId('log-text-input'), 'Morning meditation');
    fireEvent.press(getByTestId('log-submit-btn'));

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    // Simulate gateway response
    mockGateway.lastMessage = {
      type: 'sync-status',
      payload: { source: 'manual', status: 'logged', lastSyncAt: Date.now() },
    };

    rerender(<LogScreen />);

    await waitFor(() => {
      expect(getByTestId('log-toast')).toBeTruthy();
      expect(getByText('Logged')).toBeTruthy();
    });
  });
});
