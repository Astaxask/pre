import React, { createContext, useContext, type ReactNode } from 'react';
import { useGateway } from '../hooks/useGateway';

type GatewayContextValue = ReturnType<typeof useGateway>;

const GatewayContext = createContext<GatewayContextValue | null>(null);

export function GatewayProvider({ children }: { children: ReactNode }) {
  const gateway = useGateway();
  return (
    <GatewayContext.Provider value={gateway}>
      {children}
    </GatewayContext.Provider>
  );
}

export function useGatewayContext(): GatewayContextValue {
  const ctx = useContext(GatewayContext);
  if (!ctx) {
    throw new Error('useGatewayContext must be used within a GatewayProvider');
  }
  return ctx;
}
