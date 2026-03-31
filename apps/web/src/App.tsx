import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { Dashboard } from './screens/Dashboard.js';
import { Timeline } from './screens/Timeline.js';
import { Insights } from './screens/Insights.js';
import { Simulation } from './screens/Simulation.js';
import { Goals } from './screens/Goals.js';
import { Adapters } from './screens/Adapters.js';
import { Settings } from './screens/Settings.js';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="timeline" element={<Timeline />} />
        <Route path="insights" element={<Insights />} />
        <Route path="simulation" element={<Simulation />} />
        <Route path="goals" element={<Goals />} />
        <Route path="adapters" element={<Adapters />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
