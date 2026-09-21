import type { AgentType } from './agent.js';

export type SshMachineConnection = {
  host: string;
  port: number;
  user: string | null;
  privateKeyPath: string | null;
};

export type SshTaskRecord = {
  agentType: AgentType;
  controlMode: 'tmux' | 'process';
  customTitle: string | null;
  externalSessionId: string;
  createdAt: string;
  id: number;
  lastActiveAt: string;
  lastOutput: string;
  machineId: number;
  paneId: string;
  processCommand: string;
  requiredInput: string;
  sessionName: string;
  suggestedReply: string;
  status: 'running' | 'idle' | 'stopped' | 'missing';
  title: string;
  workSummary: string;
  updatedAt: string;
  windowIndex: number;
  windowName: string;
  workspacePath: string;
};

export type SshMachineProbe = {
  host: string;
  installedAgentTypes: AgentType[];
  os: string;
  tmuxVersion: string | null;
};
