export type HybridModeKey =
  | 'PREFER_ON_DEVICE'
  | 'ONLY_ON_DEVICE'
  | 'PREFER_IN_CLOUD'
  | 'ONLY_IN_CLOUD';

export type InferenceSourceLabel = 'ON_DEVICE' | 'IN_CLOUD' | 'DEMO_FALLBACK';

export type NanoStatus =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable'
  | 'unsupported'
  | 'checking';

export interface MaterialItem {
  id: string;
  name: string;
  quantity: number;
  unit: string; // pcs, ft, box, gal, hr, lot
  unitPrice: number; // USD
  lineTotal: number; // quantity * unitPrice
  category?: string;
}

export interface JobEstimate {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  clientName: string;
  siteLocation: string;
  jobDescription: string;
  tradeCategory: string;
  estimatedDurationDays: number;
  laborRatePerHour: number;
  estimatedLaborHours: number;
  priority: 'Low' | 'Normal' | 'Urgent' | 'Emergency';
  materials: MaterialItem[];
  recommendedNextSteps: string[];
  clientQuoteDraft?: string;
  rawNotes: string;
  syncedToCloud: boolean;
  lastInference?: InferenceTelemetry;
}

export interface InferenceTelemetry {
  id: string;
  timestamp: string;
  task: 'scope_extraction' | 'quote_draft' | 'receipt_scan';
  requestedMode: HybridModeKey;
  source: InferenceSourceLabel;
  modelLabel: string;
  latencyMs: number;
  estimatedCloudCostSavedUsd: number;
  onlineAtRun: boolean;
  notes?: string;
}
