import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// SPA entrypoint. Bootstraps the standalone root component with the app providers
// (router + HttpClient). nginx (nginx.conf) falls back to index.html for unknown paths so
// a hard refresh / deep link on a client route still serves the app.
bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));
