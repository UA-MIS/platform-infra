import 'package:flutter/material.dart';

import 'api_client.dart';
import 'config.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '${{ values.appName }}',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  String _result = 'Tap to call the backend.';
  bool _loading = false;

  Future<void> _ping() async {
    setState(() {
      _loading = true;
      _result = 'Calling ${AppConfig.apiBaseUrl}/healthz …';
    });
    final r = await ApiClient.health();
    if (!mounted) return;
    setState(() {
      _result = r;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('${{ values.appName }}')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('${{ values.description }}', textAlign: TextAlign.center),
            const SizedBox(height: 8),
            Text(
              'Backend: ${AppConfig.apiBaseUrl}',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 12, color: Colors.black54),
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _loading ? null : _ping,
              child: Text(_loading ? 'Calling…' : 'Ping backend /healthz'),
            ),
            const SizedBox(height: 24),
            Text(_result, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}
