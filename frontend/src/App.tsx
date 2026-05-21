import { Routes, Route, Navigate } from "react-router-dom";
import { Navbar } from "./components/Navbar";
import { OfflineBanner } from "./components/OfflineBanner";
import { useAuth } from "./contexts/AuthContext";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { Practice } from "./pages/Practice";
import { Buzzer } from "./pages/Buzzer";
import { Flashcards } from "./pages/Flashcards";
import { Friends } from "./pages/Friends";
import { Leaderboard } from "./pages/Leaderboard";
import { Dashboard } from "./pages/Dashboard";
import { Daily } from "./pages/Daily";
import { Review } from "./pages/Review";
import { FinalJeopardy } from "./pages/FinalJeopardy";
import { Board } from "./pages/Board";
import { MultiplayerBoard } from "./pages/MultiplayerBoard";
import { Settings } from "./pages/Settings";
import { NotFound } from "./pages/NotFound";
import { ReactNode } from "react";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <div className="min-h-full">
      <OfflineBanner />
      <Navbar />
      <main className="max-w-screen-2xl mx-auto px-4 py-4 md:py-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/practice" element={<Practice />} />
          <Route path="/buzzer" element={<RequireAuth><Buzzer /></RequireAuth>} />
          <Route path="/flashcards" element={<Flashcards />} />
          <Route path="/daily" element={<Daily />} />
          <Route path="/review" element={<RequireAuth><Review /></RequireAuth>} />
          <Route path="/final" element={<RequireAuth><FinalJeopardy /></RequireAuth>} />
          <Route path="/board" element={<RequireAuth><Board /></RequireAuth>} />
          <Route path="/board/multiplayer" element={<RequireAuth><MultiplayerBoard /></RequireAuth>} />
          <Route path="/board/multiplayer/:code" element={<RequireAuth><MultiplayerBoard /></RequireAuth>} />
          <Route path="/friends" element={<RequireAuth><Friends /></RequireAuth>} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
          <Route path="/daily/:date" element={<Daily />} />
          <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}
