export type FrpServerRecord = {
  bindPort: number;
  createdAt: string;
  downloadBase: string;
  id: number;
  lastError: string;
  machineId: number;
  publicAddress: string;
  status: 'not_deployed' | 'deploying' | 'online' | 'offline' | 'error';
  token: string;
  updatedAt: string;
  version: string;
};

export type FrpRelayRecord = {
  createdAt: string;
  enabled: boolean;
  id: number;
  lastError: string;
  localPort: number;
  machineId: number;
  proxyName: string;
  secretKey: string;
  serverId: number;
  status: 'not_deployed' | 'deploying' | 'online' | 'disabled' | 'error';
  updatedAt: string;
  visitorPort: number;
};
