import { Navigate, Route, Routes } from "react-router-dom";
import { HealthProvider } from "./context/HealthContext";
import { PrintersProvider } from "./context/PrintersContext";
import { ServiceModeProvider } from "./context/ServiceModeContext";
import AppLayout from "./layout/AppLayout";
import UpdatedModal from "./components/UpdatedModal";
import AboutPage from "./pages/AboutPage";
import OfflinePage from "./pages/OfflinePage";
import PrinterPage from "./pages/PrinterPage";
import StatusPage from "./pages/StatusPage";
import SupportPage from "./pages/SupportPage";
import UpdatePage from "./pages/UpdatePage";

export default function App() {
  return (
    <ServiceModeProvider>
      <HealthProvider>
        <PrintersProvider>
          <UpdatedModal />
          <Routes>
            <Route path="/" element={<AppLayout />}>
              <Route index element={<Navigate to="/status" replace />} />
              <Route path="status" element={<StatusPage />} />
              <Route path="printer" element={<PrinterPage />} />
              <Route path="offline" element={<OfflinePage />} />
              <Route path="update" element={<UpdatePage />} />
              <Route path="support" element={<SupportPage />} />
              <Route path="about" element={<AboutPage />} />
            </Route>
          </Routes>
        </PrintersProvider>
      </HealthProvider>
    </ServiceModeProvider>
  );
}
