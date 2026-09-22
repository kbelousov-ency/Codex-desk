import React from 'react';
import { createRoot } from 'react-dom/client';
import Workspace from './Workspace';
import TooltipLayer from './TooltipLayer';
import { DiagnosticsErrorBoundary } from './Diagnostics';
import { installRendererDiagnostics } from './renderer-diagnostics';
import './styles.css';
import './compact.css';

installRendererDiagnostics();
createRoot(document.getElementById('root')!).render(<React.StrictMode><DiagnosticsErrorBoundary><Workspace /><TooltipLayer /></DiagnosticsErrorBoundary></React.StrictMode>);
