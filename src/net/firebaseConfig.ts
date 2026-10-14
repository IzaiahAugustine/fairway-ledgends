// Firebase project for online matches (Realtime Database). These values are public by design:
// they identify the project, and access is governed by the database rules (database.rules.json).
// Project: fairway-legends-51e70 (Firebase console → Project settings → Your apps → Web app).
export const firebaseConfig = {
  apiKey: 'AIzaSyC8tS4f44d0JrdJX1c7mjEtpYL69ZvwhMs',
  authDomain: 'fairway-legends-51e70.firebaseapp.com',
  databaseURL: 'https://fairway-legends-51e70-default-rtdb.firebaseio.com',
  projectId: 'fairway-legends-51e70',
  storageBucket: 'fairway-legends-51e70.firebasestorage.app',
  messagingSenderId: '395979382474',
  appId: '1:395979382474:web:c16ef4667332e4773f9e33',
};

export const onlineConfigured = () => !!firebaseConfig.databaseURL;
