import './lib/boot'; // first of all: the boot guard in index.html waits for this module to run
import './lib/legacy-storage-init'; // before the modules below, which read their stored keys as they load
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { SpendCapProvider } from './components/SpendCapDialog';
import { ToastProvider } from '@claudio/ui/components/Toast';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './i18n'; // picks the language and sets <html lang> before the first render
import { probeAuth } from './lib/auth';
import { AppChatUi } from './lib/chat-ui';
import { registerServiceWorker } from './lib/pwa';
import { SplashHandOff } from './lib/splash';
import { watchChunkErrors } from './lib/reload';
import './lib/theme'; // applies the stored theme before the first paint
import '@claudio/ui/lib/motion'; // stamps the motion level before anything has a chance to animate
import { notifyPageReady } from './lib/desktop'; // marks the desktop app's window before the first paint, so the title bar never jumps
import './styles.css';
import '@claudio/ui/controls.css';
import './observe.css';
import './usage-history.css';

// Before anything lazy is asked for: the first chunk a stale page misses may be the first it loads
watchChunkErrors();
// Before the first render, so a guarded wrapper opens on its sign-in screen and not on the shell
void probeAuth();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 1000 },
  },
});

// A data router (rather than <BrowserRouter>) is what makes useBlocker available, which the
// unsaved-changes guard needs to intercept sidebar navigation. App keeps its own <Routes>.
const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <TooltipProvider>
        <ToastProvider>
          <ConfirmProvider>
            <SpendCapProvider>
              <AppChatUi>
                <App />
              </AppChatUi>
            </SpendCapProvider>
          </ConfirmProvider>
        </ToastProvider>
      </TooltipProvider>
    ),
  },
]);

/** After the first commit has painted: a payload's trial in the desktop shell counts the page as rendered */
function PageReady(): null {
  useEffect(() => {
    const frame = requestAnimationFrame(() => requestAnimationFrame(notifyPageReady));
    return () => cancelAnimationFrame(frame);
  }, []);
  return null;
}

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
    <SplashHandOff />
    <PageReady />
  </StrictMode>,
);

// After the render call, and the worker itself waits for 'load': the app shell is cached for the
// next cold start, never at the cost of this one
registerServiceWorker();
