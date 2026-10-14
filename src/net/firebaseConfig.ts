// Firebase project for online matches (Realtime Database). These values are public by design:
// they identify the project, and access is governed by the database rules (database.rules.json).
// Paste the `firebaseConfig` from Firebase console → Project settings → Your apps → Web app.
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  databaseURL: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

export const onlineConfigured = () => !!firebaseConfig.databaseURL;
