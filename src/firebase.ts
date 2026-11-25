import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAI, GoogleAIBackend, type AI } from 'firebase/ai';
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from 'firebase/app-check';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '',
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.projectId &&
    firebaseConfig.appId &&
    !firebaseConfig.apiKey.startsWith('your-') &&
    !firebaseConfig.projectId.startsWith('your-')
);

export const CLOUD_GEMINI_MODEL =
  import.meta.env.VITE_GEMINI_CLOUD_MODEL || 'gemini-3.8-flash';

// Even if cloud credentials aren't configured yet, Firebase AI Logic can still
// initialize a local app shell so ONLY_ON_DEVICE / PREFER_ON_DEVICE on-device
// Gemini Nano works in Chrome Desktop 139+.
const effectiveConfig = isFirebaseConfigured
  ? firebaseConfig
  : {
      apiKey: 'local-on-device-only-placeholder',
      authDomain: 'localhost',
      projectId: 'jerbz-fieldscope-local',
      appId: '1:000000000000:web:localondevice',
    };

export const firebaseApp: FirebaseApp = initializeApp(effectiveConfig);

// Firebase App Check (recommended for production Cloud Gemini protection)
const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY;
if (isFirebaseConfigured && recaptchaSiteKey) {
  if (import.meta.env.VITE_APPCHECK_DEBUG === 'true') {
    (
      self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean }
    ).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  initializeAppCheck(firebaseApp, {
    provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
}

// Initialize Firebase AI Logic with the Gemini Developer API backend.
// Hybrid Inference routes between Chrome Built-in Gemini Nano and Cloud Gemini.
export const ai: AI = getAI(firebaseApp, {
  backend: new GoogleAIBackend(),
});

// Offline-first Firestore instance (only written to when Firebase is configured)
export const db: Firestore | null = isFirebaseConfigured
  ? initializeFirestore(firebaseApp, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    })
  : null;
