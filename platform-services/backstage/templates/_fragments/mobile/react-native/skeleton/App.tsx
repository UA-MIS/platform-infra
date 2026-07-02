import { useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { API_BASE_URL } from './src/config';
import { health } from './src/api';

export default function App() {
  const [result, setResult] = useState('Tap to call the backend.');
  const [loading, setLoading] = useState(false);

  async function ping() {
    setLoading(true);
    setResult(`Calling ${API_BASE_URL}/healthz …`);
    const r = await health();
    setResult(r);
    setLoading(false);
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>${{ values.appName }}</Text>
      <Text style={styles.subtitle}>${{ values.description }}</Text>
      <Text style={styles.mono}>Backend: {API_BASE_URL}</Text>
      <View style={styles.spacer} />
      <Button
        title={loading ? 'Calling…' : 'Ping backend /healthz'}
        onPress={ping}
        disabled={loading}
      />
      <View style={styles.spacer} />
      <Text style={styles.result}>{result}</Text>
      <StatusBar style="auto" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 8,
  },
  title: { fontSize: 28, fontWeight: 'bold', textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#555', textAlign: 'center' },
  mono: { fontSize: 12, color: '#777', textAlign: 'center' },
  result: { fontSize: 14, textAlign: 'center' },
  spacer: { height: 16 },
});
