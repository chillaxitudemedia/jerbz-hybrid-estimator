import {
  getGenerativeModel,
  InferenceMode,
  InferenceSource,
  type HybridParams,
  type InlineDataPart,
  type TextPart,
} from 'firebase/ai';
import { ai, CLOUD_GEMINI_MODEL, isFirebaseConfigured } from '../firebase';
import type {
  HybridModeKey,
  InferenceSourceLabel,
  InferenceTelemetry,
  JobEstimate,
  MaterialItem,
  NanoStatus,
} from '../types';

const MODE_MAP: Record<HybridModeKey, InferenceMode> = {
  PREFER_ON_DEVICE: InferenceMode.PREFER_ON_DEVICE,
  ONLY_ON_DEVICE: InferenceMode.ONLY_ON_DEVICE,
  PREFER_IN_CLOUD: InferenceMode.PREFER_IN_CLOUD,
  ONLY_IN_CLOUD: InferenceMode.ONLY_IN_CLOUD,
};

// Estimated equivalent cloud cost saved per on-device run (for ROI telemetry)
const EST_CLOUD_COST_PER_SCOPE_USD = 0.0028;
const EST_CLOUD_COST_PER_QUOTE_USD = 0.0014;
const EST_CLOUD_COST_PER_RECEIPT_USD = 0.0045;

// Shared JSON Schema used by BOTH on-device Gemini Nano (responseConstraint)
// and Cloud Gemini 2.5 Flash (responseJsonSchema) for consistent structured output.
const JOB_ESTIMATE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    tradeCategory: { type: 'string' },
    jobDescription: { type: 'string' },
    estimatedDurationDays: { type: 'number' },
    estimatedLaborHours: { type: 'number' },
    priority: {
      type: 'string',
      enum: ['Low', 'Normal', 'Urgent', 'Emergency'],
    },
    materials: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: 'number' },
          unit: { type: 'string' },
          unitPrice: { type: 'number' },
        },
        required: ['name', 'quantity', 'unit', 'unitPrice'],
      },
    },
    recommendedNextSteps: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: [
    'title',
    'tradeCategory',
    'jobDescription',
    'estimatedDurationDays',
    'estimatedLaborHours',
    'priority',
    'materials',
    'recommendedNextSteps',
  ],
};

const RECEIPT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    vendorName: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: 'number' },
          unit: { type: 'string' },
          unitPrice: { type: 'number' },
        },
        required: ['name', 'quantity', 'unit', 'unitPrice'],
      },
    },
  },
  required: ['items'],
};

function mapInferenceSource(
  source: InferenceSource | undefined
): InferenceSourceLabel {
  if (source === InferenceSource.ON_DEVICE) return 'ON_DEVICE';
  return 'IN_CLOUD';
}

function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

/**
 * Probes Chrome Built-in AI (`LanguageModel.availability()`) to report
 * on-device Gemini Nano readiness in the telemetry bar.
 */
export async function checkOnDeviceNanoStatus(): Promise<NanoStatus> {
  try {
    const globalObj = globalThis as unknown as {
      LanguageModel?: {
        availability?: (opts?: {
          expectedInputs?: Array<{ type: string; languages?: string[] }>;
          expectedOutputs?: Array<{ type: string; languages?: string[] }>;
        }) => Promise<string>;
      };
    };

    if (!globalObj.LanguageModel?.availability) {
      return 'unsupported';
    }

    const status = await globalObj.LanguageModel.availability({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });

    if (
      status === 'available' ||
      status === 'downloadable' ||
      status === 'downloading' ||
      status === 'unavailable'
    ) {
      return status;
    }
    return 'unavailable';
  } catch {
    return 'unsupported';
  }
}

/**
 * Triggers on-device Gemini Nano initialization/download through Firebase AI Logic.
 * Must be called from a direct user interaction (e.g. button click).
 */
export async function initializeOnDeviceModel(
  onDownloadProgress?: (progress: number) => void
): Promise<void> {
  const model = getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      },
    },
  });

  await model.initializeDeviceModel(onDownloadProgress);
}

function assertCloudAllowedIfNeeded(mode: HybridModeKey) {
  if (
    (mode === 'ONLY_IN_CLOUD' || mode === 'PREFER_IN_CLOUD') &&
    !isFirebaseConfigured
  ) {
    throw new Error(
      'Cloud Gemini requires Firebase project credentials in .env (see README). Switch to ONLY_ON_DEVICE or PREFER_ON_DEVICE to run locally with Chrome Gemini Nano.'
    );
  }
}

async function withTransientRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes('[500') ||
        msg.includes('[503') ||
        msg.includes('high demand') ||
        msg.includes('temporarily');
      if (!isTransient || attempt === maxRetries) {
        throw err;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 1500 * (attempt + 1))
      );
    }
  }
  throw lastError;
}

export async function extractJobScopeHybrid(params: {
  notes: string;
  clientName: string;
  siteLocation: string;
  mode: HybridModeKey;
  laborRatePerHour?: number;
}): Promise<{ estimate: JobEstimate; telemetry: InferenceTelemetry }> {
  assertCloudAllowedIfNeeded(params.mode);

  const hybridParams: HybridParams = {
    mode: MODE_MAP[params.mode],
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      },
      promptOptions: {
        responseConstraint: JOB_ESTIMATE_JSON_SCHEMA,
      },
    },
    inCloudParams: {
      model: CLOUD_GEMINI_MODEL,
      systemInstruction:
        'You are a senior field-service trade estimator for Jerbz. Convert messy contractor jobsite notes into clean, accurate structured JSON with itemized materials, quantities, units, unit prices in USD, labor hours, and next steps.',
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: JOB_ESTIMATE_JSON_SCHEMA,
      },
    },
  };

  const model = getGenerativeModel(ai, hybridParams);
  const prompt = [
    'Extract a structured jobsite estimate as JSON from the field notes below.',
    'Use exact prices mentioned in the notes; if a price is not mentioned, estimate a realistic US contractor supply price.',
    'Keep material names concise and professional.',
    `Client: ${params.clientName || 'Walk-in Client'}`,
    `Location: ${params.siteLocation || 'Jobsite'}`,
    `Field Notes:\n${params.notes}`,
  ].join('\n');

  const startedAt = performance.now();
  const result = await withTransientRetry(() => model.generateContent(prompt));
  const latencyMs = Math.round(performance.now() - startedAt);

  const source = mapInferenceSource(result.response.inferenceSource);
  const rawText = result.response.text();
  const parsed = JSON.parse(stripMarkdownFences(rawText)) as {
    title?: string;
    tradeCategory?: string;
    jobDescription?: string;
    estimatedDurationDays?: number;
    estimatedLaborHours?: number;
    priority?: JobEstimate['priority'];
    materials?: Array<{
      name?: string;
      quantity?: number;
      unit?: string;
      unitPrice?: number;
    }>;
    recommendedNextSteps?: string[];
  };

  const materials: MaterialItem[] = (parsed.materials ?? []).map((item, idx) => {
    const qty = Number(item.quantity) || 1;
    const unitPrice = Number(item.unitPrice) || 0;
    return {
      id: `mat-${Date.now()}-${idx}`,
      name: item.name || 'Material Item',
      quantity: qty,
      unit: item.unit || 'pcs',
      unitPrice,
      lineTotal: Number((qty * unitPrice).toFixed(2)),
    };
  });

  const telemetry: InferenceTelemetry = {
    id: `run-${Date.now()}`,
    timestamp: new Date().toISOString(),
    task: 'scope_extraction',
    requestedMode: params.mode,
    source,
    modelLabel:
      source === 'ON_DEVICE'
        ? 'Gemini Nano (Chrome Built-in)'
        : CLOUD_GEMINI_MODEL,
    latencyMs,
    estimatedCloudCostSavedUsd:
      source === 'ON_DEVICE' ? EST_CLOUD_COST_PER_SCOPE_USD : 0,
    onlineAtRun: navigator.onLine,
  };

  const now = new Date().toISOString();
  const estimate: JobEstimate = {
    id: `est-${Date.now()}`,
    createdAt: now,
    updatedAt: now,
    title: parsed.title || 'Field Service Estimate',
    clientName: params.clientName || 'Walk-in Client',
    siteLocation: params.siteLocation || 'Jobsite',
    jobDescription: parsed.jobDescription || params.notes,
    tradeCategory: parsed.tradeCategory || 'General Contracting',
    estimatedDurationDays: Number(parsed.estimatedDurationDays) || 1,
    laborRatePerHour: params.laborRatePerHour ?? 115,
    estimatedLaborHours: Number(parsed.estimatedLaborHours) || 4,
    priority: parsed.priority || 'Normal',
    materials,
    recommendedNextSteps: Array.isArray(parsed.recommendedNextSteps)
      ? parsed.recommendedNextSteps
      : [],
    rawNotes: params.notes,
    syncedToCloud: false,
    lastInference: telemetry,
  };

  return { estimate, telemetry };
}

export async function draftClientQuoteStreamHybrid(params: {
  estimate: JobEstimate;
  mode: HybridModeKey;
  onChunk: (accumulatedText: string) => void;
}): Promise<{ text: string; telemetry: InferenceTelemetry }> {
  assertCloudAllowedIfNeeded(params.mode);

  const materialsSubtotal = params.estimate.materials.reduce(
    (sum, m) => sum + m.lineTotal,
    0
  );
  const laborSubtotal =
    params.estimate.estimatedLaborHours * params.estimate.laborRatePerHour;
  const total = materialsSubtotal + laborSubtotal;

  const model = getGenerativeModel(ai, {
    mode: MODE_MAP[params.mode],
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      },
    },
    inCloudParams: {
      model: CLOUD_GEMINI_MODEL,
      systemInstruction:
        'You write crisp, trustworthy, SMS/email-ready job quotes for field service contractors. Keep it under 140 words, clear pricing breakdown, polite call to approve.',
    },
  });

  const prompt = [
    'Write a concise client-ready quote message (under 140 words) for SMS or email.',
    `Client: ${params.estimate.clientName}`,
    `Job: ${params.estimate.title} (${params.estimate.tradeCategory})`,
    `Location: ${params.estimate.siteLocation}`,
    `Scope: ${params.estimate.jobDescription}`,
    `Materials (${params.estimate.materials.length} items): $${materialsSubtotal.toFixed(2)}`,
    `Labor (${params.estimate.estimatedLaborHours} hrs @ $${params.estimate.laborRatePerHour}/hr): $${laborSubtotal.toFixed(2)}`,
    `Estimated Total: $${total.toFixed(2)}`,
    `Estimated Duration: ${params.estimate.estimatedDurationDays} day(s)`,
    'End with a friendly request to reply YES to schedule.',
  ].join('\n');

  const startedAt = performance.now();
  const streamResult = await model.generateContentStream(prompt);
  let accumulated = '';
  for await (const chunk of streamResult.stream) {
    accumulated += chunk.text();
    params.onChunk(accumulated);
  }
  const finalResponse = await streamResult.response;
  const latencyMs = Math.round(performance.now() - startedAt);
  const source = mapInferenceSource(finalResponse.inferenceSource);

  const telemetry: InferenceTelemetry = {
    id: `run-${Date.now()}`,
    timestamp: new Date().toISOString(),
    task: 'quote_draft',
    requestedMode: params.mode,
    source,
    modelLabel:
      source === 'ON_DEVICE'
        ? 'Gemini Nano (Chrome Built-in)'
        : CLOUD_GEMINI_MODEL,
    latencyMs,
    estimatedCloudCostSavedUsd:
      source === 'ON_DEVICE' ? EST_CLOUD_COST_PER_QUOTE_USD : 0,
    onlineAtRun: navigator.onLine,
  };

  return { text: accumulated.trim(), telemetry };
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });
}

export async function scanReceiptHybrid(params: {
  file: File;
  mode: HybridModeKey;
}): Promise<{
  vendorName?: string;
  items: MaterialItem[];
  telemetry: InferenceTelemetry;
}> {
  assertCloudAllowedIfNeeded(params.mode);

  const base64Data = await fileToBase64(params.file);
  const mimeType = params.file.type || 'image/jpeg';

  const model = getGenerativeModel(ai, {
    mode: MODE_MAP[params.mode],
    onDeviceParams: {
      createOptions: {
        expectedInputs: [
          { type: 'image' },
          { type: 'text', languages: ['en'] },
        ],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      },
      promptOptions: {
        responseConstraint: RECEIPT_JSON_SCHEMA,
      },
    },
    inCloudParams: {
      model: CLOUD_GEMINI_MODEL,
      systemInstruction:
        'Extract purchased contractor materials from this supply-house receipt or parts list photo as structured JSON.',
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: RECEIPT_JSON_SCHEMA,
      },
    },
  });

  const textPart: TextPart = {
    type: 'text',
    text: 'Extract every line item (name, quantity, unit, unit price in USD) and the vendor name from this receipt or parts sheet as JSON.',
  };

  const imagePart: InlineDataPart = {
    type: 'inlineData',
    inlineData: {
      mimeType,
      data: base64Data,
    },
  };

  const startedAt = performance.now();
  const result = await withTransientRetry(() =>
    model.generateContent([textPart, imagePart])
  );
  const latencyMs = Math.round(performance.now() - startedAt);
  const source = mapInferenceSource(result.response.inferenceSource);

  const parsed = JSON.parse(stripMarkdownFences(result.response.text())) as {
    vendorName?: string;
    items?: Array<{
      name?: string;
      quantity?: number;
      unit?: string;
      unitPrice?: number;
    }>;
  };

  const items: MaterialItem[] = (parsed.items ?? []).map((item, idx) => {
    const qty = Number(item.quantity) || 1;
    const unitPrice = Number(item.unitPrice) || 0;
    return {
      id: `rcpt-${Date.now()}-${idx}`,
      name: item.name || 'Supply Item',
      quantity: qty,
      unit: item.unit || 'pcs',
      unitPrice,
      lineTotal: Number((qty * unitPrice).toFixed(2)),
    };
  });

  const telemetry: InferenceTelemetry = {
    id: `run-${Date.now()}`,
    timestamp: new Date().toISOString(),
    task: 'receipt_scan',
    requestedMode: params.mode,
    source,
    modelLabel:
      source === 'ON_DEVICE'
        ? 'Gemini Nano Multimodal'
        : CLOUD_GEMINI_MODEL,
    latencyMs,
    estimatedCloudCostSavedUsd:
      source === 'ON_DEVICE' ? EST_CLOUD_COST_PER_RECEIPT_USD : 0,
    onlineAtRun: navigator.onLine,
    notes: parsed.vendorName ? `Vendor: ${parsed.vendorName}` : undefined,
  };

  return { vendorName: parsed.vendorName, items, telemetry };
}
