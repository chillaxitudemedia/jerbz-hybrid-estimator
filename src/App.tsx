import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Cloud,
  Copy,
  Cpu,
  Download,
  FileJson,
  HardHat,
  Loader2,
  Mic,
  MicOff,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { doc, setDoc } from 'firebase/firestore';
import { CLOUD_GEMINI_MODEL, db, isFirebaseConfigured } from './firebase';
import { JOBSITE_PRESETS } from './data/presets';
import {
  checkOnDeviceNanoStatus,
  draftClientQuoteStreamHybrid,
  extractJobScopeHybrid,
  initializeOnDeviceModel,
  scanReceiptHybrid,
} from './services/hybridAiService';
import {
  buildJerbzExportPayload,
  loadLocalEstimates,
  loadTelemetryLog,
  saveLocalEstimates,
  saveTelemetryLog,
} from './services/storageService';
import type {
  HybridModeKey,
  InferenceTelemetry,
  JobEstimate,
  MaterialItem,
  NanoStatus,
} from './types';

const MODE_OPTIONS: Array<{
  key: HybridModeKey;
  label: string;
  hint: string;
}> = [
  {
    key: 'PREFER_ON_DEVICE',
    label: 'Prefer On-Device',
    hint: 'Gemini Nano first, auto-fallback to Cloud Gemini',
  },
  {
    key: 'ONLY_ON_DEVICE',
    label: 'Only On-Device',
    hint: '100% local & offline ($0.00 cloud spend)',
  },
  {
    key: 'PREFER_IN_CLOUD',
    label: 'Prefer In-Cloud',
    hint: 'Cloud Gemini first, fallback to Nano if offline',
  },
  {
    key: 'ONLY_IN_CLOUD',
    label: 'Only In-Cloud',
    hint: `Force ${CLOUD_GEMINI_MODEL} via Firebase AI Logic`,
  },
];

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

export default function App() {
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [nanoStatus, setNanoStatus] = useState<NanoStatus>('checking');
  const [nanoDownloadPct, setNanoDownloadPct] = useState<number | null>(null);
  const [mode, setMode] = useState<HybridModeKey>('PREFER_ON_DEVICE');

  // Jobsite input form
  const [clientName, setClientName] = useState(JOBSITE_PRESETS[0].clientName);
  const [siteLocation, setSiteLocation] = useState(JOBSITE_PRESETS[0].siteLocation);
  const [notes, setNotes] = useState(JOBSITE_PRESETS[0].notes);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // Active estimate & persistence
  const [estimate, setEstimate] = useState<JobEstimate | null>(null);
  const [savedEstimates, setSavedEstimates] = useState<JobEstimate[]>(() =>
    loadLocalEstimates()
  );
  const [telemetryLog, setTelemetryLog] = useState<InferenceTelemetry[]>(() =>
    loadTelemetryLog()
  );

  // Busy & UI feedback states
  const [extracting, setExtracting] = useState(false);
  const [draftingQuote, setDraftingQuote] = useState(false);
  const [scanningReceipt, setScanningReceipt] = useState(false);
  const [copiedQuote, setCopiedQuote] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    void checkOnDeviceNanoStatus().then(setNanoStatus);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const recordTelemetry = (entry: InferenceTelemetry) => {
    setTelemetryLog((prev) => {
      const next = [entry, ...prev].slice(0, 50);
      saveTelemetryLog(next);
      return next;
    });
  };

  const kpis = useMemo(() => {
    const onDeviceCount = telemetryLog.filter((t) => t.source === 'ON_DEVICE').length;
    const cloudCount = telemetryLog.filter((t) => t.source === 'IN_CLOUD').length;
    const totalSaved = telemetryLog.reduce(
      (sum, t) => sum + t.estimatedCloudCostSavedUsd,
      0
    );
    const avgLatency =
      telemetryLog.length > 0
        ? Math.round(
            telemetryLog.reduce((sum, t) => sum + t.latencyMs, 0) /
              telemetryLog.length
          )
        : 0;
    return { onDeviceCount, cloudCount, totalSaved, avgLatency };
  }, [telemetryLog]);

  const totals = useMemo(() => {
    if (!estimate) return { materials: 0, labor: 0, grand: 0 };
    const materials = estimate.materials.reduce((sum, m) => sum + m.ukupno, 0);
    const labor = estimate.estimatedLaborHours * estimate.laborRatePerHour;
    return { materials, labor, grand: materials + labor };
  }, [estimate]);

  const handleInitNano = async () => {
    setErrorMsg(null);
    setNanoDownloadPct(0);
    try {
      await initializeOnDeviceModel((progress) => {
        setNanoDownloadPct(Math.round(progress * 100));
      });
      setNanoDownloadPct(null);
      setNanoStatus(await checkOnDeviceNanoStatus());
    } catch (err) {
      setNanoDownloadPct(null);
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Unable to initialize Chrome Built-in Gemini Nano.'
      );
    }
  };

  const handleToggleVoice = () => {
    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      setIsListening(false);
      return;
    }

    const win = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Recognition = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!Recognition) {
      setErrorMsg('Web Speech API voice dictation is not supported in this browser.');
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    recognition.onresult = (event) => {
      const parts: string[] = [];
      for (let i = 0; i < event.results.length; i += 1) {
        parts.push(event.results[i][0].transcript);
      }
      setNotes((prev) => `${prev ? `${prev.trim()} ` : ''}${parts.join(' ')}`);
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  };

  const handleExtractScope = async () => {
    if (!notes.trim()) {
      setErrorMsg('Enter or dictate jobsite notes before running extraction.');
      return;
    }
    setErrorMsg(null);
    setExtracting(true);
    try {
      const { estimate: extracted, telemetry } = await extractJobScopeHybrid({
        notes,
        clientName,
        siteLocation,
        mode,
        laborRatePerHour: estimate?.laborRatePerHour ?? 115,
      });
      setEstimate(extracted);
      recordTelemetry(telemetry);
      void checkOnDeviceNanoStatus().then(setNanoStatus);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Hybrid inference failed. Check Gemini Nano status or Firebase config.'
      );
    } finally {
      setExtracting(false);
    }
  };

  const handleDraftQuote = async () => {
    if (!estimate) return;
    setErrorMsg(null);
    setDraftingQuote(true);
    setEstimate((prev) => (prev ? { ...prev, clientQuoteDraft: '' } : prev));
    try {
      const { text, telemetry } = await draftClientQuoteStreamHybrid({
        estimate,
        mode,
        onChunk: (accumulated) => {
          setEstimate((prev) =>
            prev ? { ...prev, clientQuoteDraft: accumulated } : prev
          );
        },
      });
      setEstimate((prev) =>
        prev
          ? {
              ...prev,
              clientQuoteDraft: text,
              lastInference: telemetry,
              updatedAt: new Date().toISOString(),
            }
          : prev
      );
      recordTelemetry(telemetry);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Failed to draft client quote.'
      );
    } finally {
      setDraftingQuote(false);
    }
  };

  const handleReceiptUpload = async (file: File | null) => {
    if (!file) return;
    setErrorMsg(null);
    setScanningReceipt(true);
    try {
      const { vendorName, items, telemetry } = await scanReceiptHybrid({
        file,
        mode,
      });
      recordTelemetry(telemetry);

      setEstimate((prev) => {
        const now = new Date().toISOString();
        if (!prev) {
          return {
            id: `poso-${Date.now()}`,
            createdAt: now,
            updatedAt: now,
            title: vendorName ? `${vendorName} Supply Estimate` : 'Scanned Receipt Estimate',
            clientName: clientName || 'Walk-in Client',
            siteLocation: siteLocation || 'Jobsite',
            jobDescription: `Materials scanned from receipt (${file.name}).`,
            tradeCategory: 'Supply Material Takeoff',
            estimatedDurationDays: 1,
            laborRatePerHour: 115,
            estimatedLaborHours: 2,
            priority: 'Normal',
            materials: items,
            recommendedNextSteps: ['Verify quantities against jobsite takeoff'],
            rawNotes: notes,
            syncedToCloud: false,
            lastInference: telemetry,
          };
        }
        return {
          ...prev,
          updatedAt: now,
          materials: [...prev.materials, ...items],
          lastInference: telemetry,
        };
      });
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Receipt scan failed. Ensure Firebase Cloud Gemini is configured for multimodal fallback.'
      );
    } finally {
      setScanningReceipt(false);
    }
  };

  const handleUpdateMaterial = (
    id: string,
    field: keyof Pick<MaterialItem, 'naziv' | 'kolicina' | 'jedinica' | 'jedinicnaCijena'>,
    value: string
  ) => {
    setEstimate((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        materials: prev.materials.map((item) => {
          if (item.id !== id) return item;
          const next = {
            ...item,
            [field]:
              field === 'kolicina' || field === 'jedinicnaCijena'
                ? Number(value) || 0
                : value,
          };
          next.ukupno = Number((next.kolicina * next.jedinicnaCijena).toFixed(2));
          return next;
        }),
      };
    });
  };

  const handleAddMaterial = () => {
    setEstimate((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        materials: [
          ...prev.materials,
          {
            id: `mat-${Date.now()}`,
            naziv: 'New Material',
            kolicina: 1,
            jedinica: 'pcs',
            jedinicnaCijena: 0,
            ukupno: 0,
          },
        ],
      };
    });
  };

  const handleDeleteMaterial = (id: string) => {
    setEstimate((prev) =>
      prev
        ? { ...prev, materials: prev.materials.filter((m) => m.id !== id) }
        : prev
    );
  };

  const handleSaveEstimate = async () => {
    if (!estimate) return;
    let synced = false;
    if (db && isFirebaseConfigured) {
      try {
        await setDoc(doc(db, 'fieldscope_estimates', estimate.id), {
          ...estimate,
          updatedAt: new Date().toISOString(),
        });
        synced = true;
      } catch {
        // Offline or Firestore rules restricted — keep safely stored locally
      }
    }

    const updated: JobEstimate = {
      ...estimate,
      syncedToCloud: synced,
      updatedAt: new Date().toISOString(),
    };
    setEstimate(updated);
    setSavedEstimates((prev) => {
      const next = [updated, ...prev.filter((e) => e.id !== updated.id)];
      saveLocalEstimates(next);
      return next;
    });
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1800);
  };

  const handleExportJerbzJson = () => {
    if (!estimate) return;
    const payload = buildJerbzExportPayload(estimate);
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${estimate.id}-jerbz-poso.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyQuote = async () => {
    if (!estimate?.clientQuoteDraft) return;
    await navigator.clipboard.writeText(estimate.clientQuoteDraft);
    setCopiedQuote(true);
    setTimeout(() => setCopiedQuote(false), 1600);
  };

  return (
    <div className="app-shell">
      {/* Top Status & Identity Bar */}
      <header className="topbar">
        <div className="brand-group">
          <div className="brand-mark" aria-hidden="true">
            <HardHat size={22} />
          </div>
          <div>
            <h1 className="brand-title">Jerbz™ FieldScope</h1>
            <p className="brand-subtitle">
              Offline-First Hybrid AI Jobsite Estimator • Firebase AI Logic
            </p>
          </div>
        </div>

        <div className="status-pills">
          <span className={`pill ${isOnline ? 'pill-edge' : 'pill-offline'}`}>
            {isOnline ? <Wifi size={14} /> : <WifiOff size={14} />}
            {isOnline ? 'Online' : 'Offline (Dead Zone)'}
          </span>

          <span
            className={`pill ${
              nanoStatus === 'available'
                ? 'pill-edge'
                : nanoStatus === 'downloadable' || nanoStatus === 'downloading'
                ? 'pill-warn'
                : ''
            }`}
          >
            <Cpu size={14} />
            Gemini Nano:{' '}
            {nanoDownloadPct !== null
              ? `Downloading ${nanoDownloadPct}%`
              : nanoStatus}
          </span>

          {(nanoStatus === 'downloadable' || nanoStatus === 'downloading') && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={handleInitNano}
              disabled={nanoDownloadPct !== null}
            >
              <Download size={14} />
              Init Nano
            </button>
          )}

          <span className={`pill ${isFirebaseConfigured ? 'pill-cloud' : 'pill-warn'}`}>
            <Cloud size={14} />
            {isFirebaseConfigured ? `Cloud: ${CLOUD_GEMINI_MODEL}` : 'Cloud: Local Mode'}
          </span>
        </div>
      </header>

      {!isFirebaseConfigured && (
        <div className="setup-banner" role="status">
          <span>
            <strong>On-Device Ready / Cloud Unconfigured:</strong> Add your Firebase project keys to{' '}
            <code>.env</code> (see <code>.env.example</code>) and run{' '}
            <code>npx -y firebase-tools@latest init ailogic</code> to enable Cloud Gemini fallback &amp;
            Firestore sync.
          </span>
        </div>
      )}

      {/* Hybrid Inference Mode & Live ROI Telemetry Strip */}
      <section className="control-strip" aria-label="Hybrid Inference Controls">
        <div className="mode-group">
          <span className="mode-label">InferenceMode</span>
          {MODE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className="mode-btn"
              title={opt.hint}
              aria-pressed={mode === opt.key}
              onClick={() => setMode(opt.key)}
            >
              {opt.key.includes('ON_DEVICE') ? <Zap size={13} /> : <Cloud size={13} />}
              {opt.label}
            </button>
          ))}
        </div>

        <div className="kpi-strip">
          <div className="kpi-item">
            <span className="kpi-label">On-Device Runs</span>
            <span className="kpi-value edge">{kpis.onDeviceCount}</span>
          </div>
          <div className="kpi-item">
            <span className="kpi-label">Cloud Runs</span>
            <span className="kpi-value">{kpis.cloudCount}</span>
          </div>
          <div className="kpi-item">
            <span className="kpi-label">Avg Latency</span>
            <span className="kpi-value">
              {kpis.avgLatency > 0 ? `${kpis.avgLatency} ms` : '—'}
            </span>
          </div>
          <div className="kpi-item">
            <span className="kpi-label">Cloud Spend Saved</span>
            <span className="kpi-value edge">${kpis.totalSaved.toFixed(4)}</span>
          </div>
        </div>
      </section>

      {errorMsg && (
        <div className="error-box" role="alert">
          {errorMsg}
        </div>
      )}

      {/* Main Two-Column Workbench */}
      <main className="workbench">
        {/* LEFT COLUMN: Field Capture, Receipt Scanner, Saved Ledger */}
        <div className="stack-col">
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">
                <Sparkles size={16} /> Field Notes Capture
              </h2>
              <button
                type="button"
                className={`btn btn-sm ${isListening ? 'btn-primary' : ''}`}
                onClick={handleToggleVoice}
              >
                {isListening ? <MicOff size={14} /> : <Mic size={14} />}
                {isListening ? 'Stop Dictation' : 'Dictate'}
              </button>
            </div>

            <div className="preset-row">
              {JOBSITE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="preset-chip"
                  onClick={() => {
                    setClientName(preset.clientName);
                    setSiteLocation(preset.siteLocation);
                    setNotes(preset.notes);
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="field-grid">
              <div className="field">
                <label htmlFor="client-name">Client / Site Owner</label>
                <input
                  id="client-name"
                  className="input"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="Summit Medical Plaza"
                />
              </div>
              <div className="field">
                <label htmlFor="site-location">Jobsite Location</label>
                <input
                  id="site-location"
                  className="input"
                  value={siteLocation}
                  onChange={(e) => setSiteLocation(e.target.value)}
                  placeholder="Sub-basement mechanical room"
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="field-notes">Raw Jobsite Notes (Works Offline)</label>
              <textarea
                id="field-notes"
                className="textarea"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Paste or dictate scope, parts needed, quantities, and labor estimate..."
              />
            </div>

            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleExtractScope}
                disabled={extracting}
              >
                {extracting ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Zap size={15} />
                )}
                {extracting ? 'Running Hybrid AI...' : 'Extract Scope & Materials'}
              </button>
            </div>
          </section>

          {/* Multimodal Receipt / Parts Sheet Scanner */}
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">
                <Camera size={16} /> Supply Receipt Scanner
              </h2>
              <span className="muted">Multimodal Hybrid</span>
            </div>
            <label className="dropzone">
              <input
                type="file"
                accept="image/*"
                disabled={scanningReceipt}
                onChange={(e) => {
                  void handleReceiptUpload(e.target.files?.[0] ?? null);
                  e.target.value = '';
                }}
              />
              {scanningReceipt ? (
                <>
                  <Loader2 size={20} className="spin" />
                  <span>Scanning receipt via Firebase AI Logic...</span>
                </>
              ) : (
                <>
                  <Camera size={20} />
                  <strong>Upload or snap a supply-house receipt / parts list</strong>
                  <span>
                    Uses on-device multimodal if available, or seamlessly falls back to{' '}
                    {CLOUD_GEMINI_MODEL}
                  </span>
                </>
              )}
            </label>
          </section>

          {/* Offline-First Saved Estimates Ledger */}
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Saved Estimates ({savedEstimates.length})</h2>
              <span className="muted">Offline-first ledger</span>
            </div>
            {savedEstimates.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No saved estimates yet. Extract a jobsite scope and click Save.
              </p>
            ) : (
              <div className="saved-list">
                {savedEstimates.map((item) => {
                  const matTotal = item.materials.reduce((s, m) => s + m.ukupno, 0);
                  const grand =
                    matTotal + item.estimatedLaborHours * item.laborRatePerHour;
                  return (
                    <div
                      key={item.id}
                      className="saved-item"
                      onClick={() => setEstimate(item)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') setEstimate(item);
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '0.86rem' }}>
                          {item.title}
                        </div>
                        <div className="muted">
                          {item.clientName} • ${grand.toFixed(2)} •{' '}
                          {item.syncedToCloud ? 'Synced' : 'Local'}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`Delete ${item.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSavedEstimates((prev) => {
                            const next = prev.filter((x) => x.id !== item.id);
                            saveLocalEstimates(next);
                            return next;
                          });
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* RIGHT COLUMN: Structured Estimate Workbench, Client Quote, Telemetry */}
        <div className="stack-col">
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Structured Jobsite Estimate</h2>
              {estimate?.lastInference && (
                <span
                  className={`pill ${
                    estimate.lastInference.source === 'ON_DEVICE'
                      ? 'pill-edge'
                      : 'pill-cloud'
                  }`}
                >
                  {estimate.lastInference.source === 'ON_DEVICE' ? (
                    <Zap size={13} />
                  ) : (
                    <Cloud size={13} />
                  )}
                  {estimate.lastInference.source === 'ON_DEVICE'
                    ? `ON_DEVICE • ${estimate.lastInference.latencyMs}ms • $0.00`
                    : `IN_CLOUD • ${estimate.lastInference.latencyMs}ms`}
                </span>
              )}
            </div>

            {!estimate ? (
              <p className="muted" style={{ margin: 0 }}>
                Pick a preset or enter raw jobsite notes on the left, then click{' '}
                <strong>Extract Scope &amp; Materials</strong> to see Firebase AI Logic route
                between Chrome Gemini Nano and Cloud Gemini in real time.
              </p>
            ) : (
              <>
                <div className="field-grid">
                  <div className="field">
                    <label htmlFor="est-title">Job Title</label>
                    <input
                      id="est-title"
                      className="input"
                      value={estimate.title}
                      onChange={(e) =>
                        setEstimate({ ...estimate, title: e.target.value })
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="est-priority">Priority</label>
                    <select
                      id="est-priority"
                      className="select"
                      value={estimate.priority}
                      onChange={(e) =>
                        setEstimate({
                          ...estimate,
                          priority: e.target.value as JobEstimate['priority'],
                        })
                      }
                    >
                      <option value="Low">Low</option>
                      <option value="Normal">Normal</option>
                      <option value="Urgent">Urgent</option>
                      <option value="Emergency">Emergency</option>
                    </select>
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="est-desc">Scope Summary</label>
                  <textarea
                    id="est-desc"
                    className="textarea"
                    style={{ minHeight: 74 }}
                    value={estimate.jobDescription}
                    onChange={(e) =>
                      setEstimate({ ...estimate, jobDescription: e.target.value })
                    }
                  />
                </div>

                <div className="field-grid">
                  <div className="field">
                    <label htmlFor="est-hours">Labor Hours</label>
                    <input
                      id="est-hours"
                      type="number"
                      min={0}
                      step={0.5}
                      className="input"
                      value={estimate.estimatedLaborHours}
                      onChange={(e) =>
                        setEstimate({
                          ...estimate,
                          estimatedLaborHours: Number(e.target.value) || 0,
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="est-rate">Labor Rate (USD/hr)</label>
                    <input
                      id="est-rate"
                      type="number"
                      min={0}
                      step={5}
                      className="input"
                      value={estimate.laborRatePerHour}
                      onChange={(e) =>
                        setEstimate({
                          ...estimate,
                          laborRatePerHour: Number(e.target.value) || 0,
                        })
                      }
                    />
                  </div>
                </div>

                <div className="card-header">
                  <span style={{ fontWeight: 700, fontSize: '0.86rem' }}>
                    Itemized Materials (Jerbz StavkaMaterijala Schema)
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={handleAddMaterial}
                  >
                    <Plus size={14} /> Add Line
                  </button>
                </div>

                <div className="table-wrap">
                  <table className="materials-table">
                    <thead>
                      <tr>
                        <th>Material / Part</th>
                        <th className="num" style={{ width: 76 }}>Qty</th>
                        <th style={{ width: 78 }}>Unit</th>
                        <th className="num" style={{ width: 100 }}>Unit $</th>
                        <th className="num" style={{ width: 100 }}>Total</th>
                        <th style={{ width: 42 }} aria-label="Remove" />
                      </tr>
                    </thead>
                    <tbody>
                      {estimate.materials.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <input
                              className="inline-input"
                              value={item.naziv}
                              onChange={(e) =>
                                handleUpdateMaterial(item.id, 'naziv', e.target.value)
                              }
                            />
                          </td>
                          <td className="num">
                            <input
                              className="inline-input num"
                              type="number"
                              min={0}
                              step={0.5}
                              value={item.kolicina}
                              onChange={(e) =>
                                handleUpdateMaterial(
                                  item.id,
                                  'kolicina',
                                  e.target.value
                                )
                              }
                            />
                          </td>
                          <td>
                            <input
                              className="inline-input"
                              value={item.jedinica}
                              onChange={(e) =>
                                handleUpdateMaterial(
                                  item.id,
                                  'jedinica',
                                  e.target.value
                                )
                              }
                            />
                          </td>
                          <td className="num">
                            <input
                              className="inline-input num"
                              type="number"
                              min={0}
                              step={0.5}
                              value={item.jedinicnaCijena}
                              onChange={(e) =>
                                handleUpdateMaterial(
                                  item.id,
                                  'jedinicnaCijena',
                                  e.target.value
                                )
                              }
                            />
                          </td>
                          <td className="num" style={{ fontWeight: 700 }}>
                            ${item.ukupno.toFixed(2)}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-sm"
                              aria-label={`Remove ${item.naziv}`}
                              onClick={() => handleDeleteMaterial(item.id)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="totals-grid">
                  <div className="total-box">
                    <div className="total-box-label">Materials</div>
                    <div className="total-box-val">${totals.materials.toFixed(2)}</div>
                  </div>
                  <div className="total-box">
                    <div className="total-box-label">Labor</div>
                    <div className="total-box-val">${totals.labor.toFixed(2)}</div>
                  </div>
                  <div className="total-box grand">
                    <div className="total-box-label">Estimated Total</div>
                    <div className="total-box-val">${totals.grand.toFixed(2)}</div>
                  </div>
                </div>

                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleDraftQuote}
                    disabled={draftingQuote}
                  >
                    {draftingQuote ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Sparkles size={14} />
                    )}
                    {draftingQuote ? 'Streaming Quote...' : 'Draft Client Quote (Stream)'}
                  </button>
                  <button type="button" className="btn" onClick={handleSaveEstimate}>
                    {savedFlash ? <Check size={14} /> : <Save size={14} />}
                    {savedFlash ? 'Saved' : 'Save Estimate'}
                  </button>
                  <button type="button" className="btn" onClick={handleExportJerbzJson}>
                    <FileJson size={14} />
                    Export Jerbz JSON
                  </button>
                </div>
              </>
            )}
          </section>

          {/* Streaming Client Quote Card */}
          {estimate?.clientQuoteDraft !== undefined && (
            <section className="card">
              <div className="card-header">
                <h2 className="card-title">Client-Ready Quote (SMS / Email)</h2>
                <button type="button" className="btn btn-sm" onClick={handleCopyQuote}>
                  {copiedQuote ? <Check size={13} /> : <Copy size={13} />}
                  {copiedQuote ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="quote-box">
                {estimate.clientQuoteDraft || 'Generating quote...'}
              </div>
            </section>
          )}

          {/* Live Hybrid Telemetry Log */}
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Hybrid Inference Telemetry Log</h2>
              <span className="muted">Live `response.inferenceSource` trace</span>
            </div>
            {telemetryLog.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Run any AI action to inspect real-time on-device vs. cloud routing,
                latency, and cloud cost avoided.
              </p>
            ) : (
              <div className="telemetry-list">
                {telemetryLog.map((entry) => (
                  <div key={entry.id} className="telemetry-row">
                    <span
                      className={`pill ${
                        entry.source === 'ON_DEVICE' ? 'pill-edge' : 'pill-cloud'
                      }`}
                    >
                      {entry.source === 'ON_DEVICE' ? (
                        <Zap size={12} />
                      ) : (
                        <Cloud size={12} />
                      )}
                      {entry.source}
                    </span>
                    <span>
                      <strong>{entry.task}</strong> • {entry.modelLabel}
                    </span>
                    <span className="muted">
                      {entry.requestedMode} • {entry.latencyMs}ms •{' '}
                      {entry.onlineAtRun ? 'Online' : 'Offline'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
