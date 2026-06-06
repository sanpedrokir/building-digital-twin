"use client";

import { useState, useRef, useEffect } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type Asset = {
  id: number;
  asset_name: string;
  floor_no: number;
  status: "operational" | "faulty" | "maintenance";
  last_updated: string;
};

const STATUS_COLOR: Record<string, string> = {
  operational: "bg-emerald-500",
  healthy: "bg-emerald-500",
  faulty: "bg-red-500",
  damaged: "bg-red-500",
  fault: "bg-red-500",
  maintenance: "bg-amber-400",
  warning: "bg-amber-400",
};

const STATUS_TEXT: Record<string, string> = {
  operational: "text-emerald-400",
  healthy: "text-emerald-400",
  faulty: "text-red-400",
  damaged: "text-red-400",
  fault: "text-red-400",
  maintenance: "text-amber-400",
  warning: "text-amber-400",
};

// Normalise status to lowercase for all lookups
function statusKey(s: string) { return s?.toLowerCase() ?? ""; }

// ── SVG Illustrations ────────────────────────────────────────────────────────

function LiftSVG({ status }: { status: string }) {
  const s = statusKey(status);
  const isOk = s === "operational" || s === "healthy";
  const isFaulty = s === "faulty" || s === "damaged" || s === "fault";
  const isMaint = s === "maintenance" || s === "warning";

  const shaftColor = isOk ? "#1e3a2f" : isFaulty ? "#3a1e1e" : "#3a311e";
  const cabinColor = isOk ? "#22c55e" : isFaulty ? "#ef4444" : "#f59e0b";
  const doorColor = isOk ? "#16a34a" : isFaulty ? "#dc2626" : "#d97706";
  const indicatorColor = isOk ? "#4ade80" : isFaulty ? "#f87171" : "#fbbf24";

  // Door gap: faulty = stuck open, maintenance = half open, operational = closed
  const doorGap = isFaulty ? 28 : isMaint ? 14 : 2;

  return (
    <svg viewBox="0 0 160 240" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
      {/* Shaft */}
      <rect x="10" y="10" width="140" height="220" rx="6" fill={shaftColor} stroke="#374151" strokeWidth="2" />

      {/* Guide rails */}
      <rect x="22" y="20" width="6" height="200" rx="3" fill="#374151" />
      <rect x="132" y="20" width="6" height="200" rx="3" fill="#374151" />

      {/* Cable */}
      <line x1="80" y1="20" x2="80" y2="55" stroke="#6b7280" strokeWidth="2" strokeDasharray="4,2" />

      {/* Cabin body */}
      <rect x="30" y="55" width="100" height="130" rx="4" fill={cabinColor} opacity="0.15" stroke={cabinColor} strokeWidth="2" />

      {/* Left door */}
      <rect x="32" y="57" width={46 - doorGap} height="126" rx="2" fill={doorColor} opacity="0.85" />
      {/* Right door */}
      <rect x={82 + doorGap} y="57" width={46 - doorGap} height="126" rx="2" fill={doorColor} opacity="0.85" />

      {/* Door centre line */}
      {!isFaulty && (
        <line x1="80" y1="57" x2="80" y2="183" stroke="#111827" strokeWidth="1" opacity="0.4" />
      )}

      {/* Floor display panel */}
      <rect x="55" y="62" width="50" height="22" rx="3" fill="#111827" />
      <text x="80" y="78" textAnchor="middle" fill={indicatorColor} fontSize="12" fontFamily="monospace" fontWeight="bold">
        {isOk ? "● RUN" : isFaulty ? "✕ ERR" : "⚙ MNT"}
      </text>

      {/* Up/Down arrows (only when operational) */}
      {isOk && (
        <>
          <text x="42" y="120" fill="#4ade80" fontSize="18" opacity="0.7">▲</text>
          <text x="42" y="145" fill="#4ade80" fontSize="18" opacity="0.3">▼</text>
        </>
      )}

      {/* Warning triangle (faulty) */}
      {isFaulty && (
        <>
          <polygon points="80,90 60,130 100,130" fill="none" stroke="#fbbf24" strokeWidth="3" />
          <text x="80" y="124" textAnchor="middle" fill="#fbbf24" fontSize="16" fontWeight="bold">!</text>
        </>
      )}

      {/* Wrench icon (maintenance) */}
      {isMaint && (
        <text x="80" y="135" textAnchor="middle" fontSize="36" opacity="0.7">🔧</text>
      )}

      {/* Bottom floor indicator lights */}
      <circle cx="55" cy="205" r="5" fill={isOk ? "#4ade80" : "#374151"} />
      <circle cx="72" cy="205" r="5" fill={isMaint ? "#fbbf24" : "#374151"} />
      <circle cx="89" cy="205" r="5" fill={isFaulty ? "#f87171" : "#374151"} />
      <circle cx="106" cy="205" r="5" fill={isOk ? "#4ade80" : "#374151"} />

      {/* Pulsing ring for faulty */}
      {isFaulty && (
        <circle cx="80" cy="110" r="45" fill="none" stroke="#ef4444" strokeWidth="1.5" opacity="0.3">
          <animate attributeName="r" values="40;55;40" dur="1.5s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.4;0;0.4" dur="1.5s" repeatCount="indefinite" />
        </circle>
      )}
    </svg>
  );
}

function HvacSVG({ status }: { status: string }) {
  const isOk = statusKey(status) === "operational" || statusKey(status) === "healthy";
  const isFaulty = statusKey(status) === "faulty" || statusKey(status) === "damaged";
  const color = isOk ? "#22c55e" : isFaulty ? "#ef4444" : "#f59e0b";
  const fanSpeed = isOk ? "0.6s" : isMaint(status) ? "2s" : "0s";

  function isMaint(s: string) { return s === "maintenance"; }

  return (
    <svg viewBox="0 0 160 160" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
      <rect x="10" y="30" width="140" height="100" rx="8" fill="#1f2937" stroke={color} strokeWidth="2" />
      {/* Vents */}
      {[45, 55, 65, 75, 85, 95, 105].map((y) => (
        <line key={y} x1="20" y1={y} x2="70" y2={y} stroke="#374151" strokeWidth="3" strokeLinecap="round" />
      ))}
      {/* Fan blade group */}
      <g transform="translate(110,80)">
        <g>
          <ellipse cx="0" cy="-18" rx="8" ry="16" fill={color} opacity="0.8" />
          <ellipse cx="16" cy="9" rx="8" ry="16" fill={color} opacity="0.8" transform="rotate(120)" />
          <ellipse cx="-16" cy="9" rx="8" ry="16" fill={color} opacity="0.8" transform="rotate(240)" />
          <circle cx="0" cy="0" r="7" fill="#111827" stroke={color} strokeWidth="2" />
          {isOk && (
            <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur={fanSpeed} repeatCount="indefinite" />
          )}
        </g>
      </g>
      {/* Status label */}
      <text x="80" y="148" textAnchor="middle" fill={color} fontSize="10" fontFamily="monospace">
        {isOk ? "COOLING  ●" : isFaulty ? "FAULT  ✕" : "MAINTENANCE  ⚙"}
      </text>
      {isFaulty && (
        <text x="40" y="80" textAnchor="middle" fill="#fbbf24" fontSize="22">⚠</text>
      )}
    </svg>
  );
}

function GenericAssetSVG({ status }: { status: string }) {
  const isOk = status === "operational";
  const isFaulty = status === "faulty";
  const color = isOk ? "#22c55e" : isFaulty ? "#ef4444" : "#f59e0b";
  const icon = isFaulty ? "⚠" : status === "maintenance" ? "🔧" : "✓";

  return (
    <svg viewBox="0 0 160 160" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
      <rect x="20" y="20" width="120" height="120" rx="12" fill="#1f2937" stroke={color} strokeWidth="2.5" />
      <text x="80" y="88" textAnchor="middle" fontSize="40">{icon}</text>
      <text x="80" y="115" textAnchor="middle" fill={color} fontSize="10" fontFamily="monospace">
        {status.toUpperCase()}
      </text>
      <circle cx="80" cy="145" r="5" fill={color} opacity="0.7">
        {isOk && <animate attributeName="opacity" values="0.7;0.2;0.7" dur="2s" repeatCount="indefinite" />}
      </circle>
    </svg>
  );
}

function AssetVisual({ asset }: { asset: Asset }) {
  const name = asset.asset_name.toLowerCase();
  const isLift = name.includes("lift") || name.includes("elevator");
  const isHvac = name.includes("hvac") || name.includes("air") || name.includes("fan") || name.includes("cool");

  if (isLift) return <LiftSVG status={asset.status} />;
  if (isHvac) return <HvacSVG status={asset.status} />;
  return <GenericAssetSVG status={asset.status} />;
}

// ── Asset Detail Modal ────────────────────────────────────────────────────────

function AssetModal({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const sk = statusKey(asset.status);
  const isOkModal = sk === "operational" || sk === "healthy";
  const isFaultyModal = sk === "faulty" || sk === "damaged" || sk === "fault";
  const bgRingClass = isOkModal
    ? "border-emerald-500"
    : isFaultyModal
    ? "border-red-500"
    : "border-amber-400";
  const badgeClass = isOkModal
    ? "bg-emerald-900/50 text-emerald-400"
    : isFaultyModal
    ? "bg-red-900/50 text-red-400 animate-pulse"
    : "bg-amber-900/50 text-amber-400";
  const badgeLabel = isOkModal ? "Operational" : isFaultyModal ? "Faulty" : "Under Maintenance";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`bg-gray-900 border-2 ${bgRingClass} rounded-2xl p-6 w-80 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-white font-bold text-lg">{asset.asset_name}</h3>
            <p className="text-gray-400 text-xs">Floor {asset.floor_no}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">✕</button>
        </div>

        {/* Live visual */}
        <div className="w-full h-52 mb-4 flex items-center justify-center">
          <AssetVisual asset={asset} />
        </div>

        {/* Status badge */}
        <div className={`text-center py-2 rounded-xl text-sm font-bold ${badgeClass}`}>
          {badgeLabel}
        </div>

        <p className="text-gray-600 text-xs text-center mt-3">
          Last updated: {new Date(asset.last_updated).toLocaleString()}
        </p>
      </div>
    </div>
  );
}

// ── Asset Card (clickable) ────────────────────────────────────────────────────

function AssetCard({ asset, onClick }: { asset: Asset; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 hover:border-blue-500 hover:bg-gray-750 transition-colors text-left"
    >
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2.5 h-2.5 rounded-full ${STATUS_COLOR[statusKey(asset.status)] ?? "bg-gray-500"}`} />
        <span className="text-sm text-gray-200">{asset.asset_name}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className={`text-xs font-semibold capitalize ${STATUS_TEXT[statusKey(asset.status)] ?? "text-gray-400"}`}>
          {asset.status}
        </span>
        <span className="text-gray-600 text-xs">👁</span>
      </div>
    </button>
  );
}

// ── Building Panel ────────────────────────────────────────────────────────────

function BuildingPanel({
  assets,
  loading,
  onSelectAsset,
}: {
  assets: Asset[];
  loading: boolean;
  onSelectAsset: (a: Asset) => void;
}) {
  const floors = Array.from(new Set(assets.map((a) => a.floor_no))).sort((a, b) => b - a);
  const total = assets.length;
  const operational = assets.filter((a) => statusKey(a.status) === "operational" || statusKey(a.status) === "healthy").length;
  const healthScore = total > 0 ? Math.round((operational / total) * 100) : 100;
  const scoreColor = healthScore >= 80 ? "text-emerald-400" : healthScore >= 50 ? "text-amber-400" : "text-red-400";

  return (
    <div className="flex flex-col h-full bg-gray-900 border-r border-gray-700">
      <div className="px-5 py-4 border-b border-gray-700">
        <h2 className="text-lg font-bold text-white">Building Status</h2>
        {!loading && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-sm text-gray-400">Health Score:</span>
            <span className={`text-2xl font-bold ${scoreColor}`}>{healthScore}/100</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
        {loading ? (
          <p className="text-gray-500 text-sm text-center mt-8">Loading assets...</p>
        ) : floors.length === 0 ? (
          <p className="text-gray-500 text-sm text-center mt-8">No asset data found.</p>
        ) : (
          floors.map((floor) => (
            <div key={floor}>
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2 tracking-wider">Floor {floor}</p>
              <div className="space-y-1.5">
                {assets
                  .filter((a) => a.floor_no === floor)
                  .map((asset) => (
                    <AssetCard key={asset.id} asset={asset} onClick={() => onSelectAsset(asset)} />
                  ))}
              </div>
            </div>
          ))
        )}
      </div>

      {!loading && (
        <div className="px-4 py-3 border-t border-gray-700 grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-emerald-400 font-bold text-lg">{assets.filter((a) => { const s = statusKey(a.status); return s === "operational" || s === "healthy"; }).length}</p>
            <p className="text-xs text-gray-500">OK</p>
          </div>
          <div>
            <p className="text-amber-400 font-bold text-lg">{assets.filter((a) => { const s = statusKey(a.status); return s === "maintenance" || s === "warning"; }).length}</p>
            <p className="text-xs text-gray-500">Maint.</p>
          </div>
          <div>
            <p className="text-red-400 font-bold text-lg">{assets.filter((a) => { const s = statusKey(a.status); return s === "faulty" || s === "damaged" || s === "fault"; }).length}</p>
            <p className="text-xs text-gray-500">Faulty</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Chat Panel ────────────────────────────────────────────────────────────────

function ChatPanel({ messages, onSend, loading }: { messages: Message[]; onSend: (msg: string) => void; loading: boolean }) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    setInput("");
    onSend(trimmed);
  };

  return (
    <div className="flex flex-col h-full bg-gray-950">
      <div className="px-5 py-4 border-b border-gray-700">
        <h2 className="text-lg font-bold text-white">AI Assistant</h2>
        <p className="text-xs text-gray-500 mt-0.5">Ask about building health, assets, or simulations</p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-6 pb-8">
            <div className="text-center">
              <p className="text-gray-300 font-semibold text-base mb-1">What would you like to simulate?</p>
              <p className="text-gray-500 text-sm">Type a question or choose a suggestion below</p>
            </div>
            <div className="w-full max-w-lg space-y-2">
              {[
                "Simulate if Lift B fails",
                "What is the building health score?",
                "Show me all faulty assets",
                "Update Elevator 1 to operational",
              ].map((q) => (
                <button
                  key={q}
                  onClick={() => onSend(q)}
                  className="block w-full text-left px-4 py-3 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors border border-gray-700 hover:border-blue-500"
                >
                  <span className="text-blue-400 mr-2">→</span>{q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-blue-600 text-white rounded-br-sm"
                  : "bg-gray-800 text-gray-200 rounded-bl-sm border border-gray-700"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-800 border border-gray-700 px-4 py-2.5 rounded-2xl rounded-bl-sm">
              <div className="flex gap-1.5 items-center h-4">
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="px-5 py-4 border-t border-gray-700 bg-gray-900">
        <div className="flex gap-3 items-center bg-gray-800 border-2 border-gray-600 focus-within:border-blue-500 rounded-2xl px-4 py-3 transition-colors">
          <span className="text-gray-500 text-lg">💬</span>
          <input
            className="flex-1 bg-transparent text-white placeholder-gray-500 focus:outline-none text-sm"
            placeholder='e.g. "Simulate if Lift B fails" or "Show faulty assets"'
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            disabled={loading}
            autoFocus
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors shrink-0"
          >
            {loading ? "..." : "Send"}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-2 text-center">Press Enter or click Send</p>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);

  const fetchAssets = async () => {
    try {
      const res = await fetch("/api/assets");
      const data = await res.json();
      if (Array.isArray(data)) setAssets(data);
    } catch {
      // silently fail
    } finally {
      setAssetsLoading(false);
    }
  };

  useEffect(() => {
    fetchAssets();
  }, []);

  // Refresh asset panel if a selected asset's status changed
  useEffect(() => {
    if (selectedAsset) {
      const updated = assets.find((a) => a.id === selectedAsset.id);
      if (updated) setSelectedAsset(updated);
    }
  }, [assets]);

  const handleSend = async (message: string) => {
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setChatLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
      fetchAssets();
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Failed to reach the server. Please try again." },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white">
      <header className="flex items-center gap-3 px-6 py-3 border-b border-gray-700 bg-gray-900 shrink-0">
        <div className="w-3 h-3 rounded-full bg-blue-500" />
        <h1 className="text-base font-bold tracking-tight">Building Digital Twin</h1>
        <span className="ml-2 text-xs text-gray-500">Click any asset to see its live visual</span>
        <span className="ml-auto text-xs text-gray-500">AI-Powered Facility Monitor</span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-72 shrink-0 overflow-hidden">
          <BuildingPanel assets={assets} loading={assetsLoading} onSelectAsset={setSelectedAsset} />
        </div>
        <div className="flex-1 overflow-hidden">
          <ChatPanel messages={messages} onSend={handleSend} loading={chatLoading} />
        </div>
      </div>

      {selectedAsset && (
        <AssetModal asset={selectedAsset} onClose={() => setSelectedAsset(null)} />
      )}
    </div>
  );
}
