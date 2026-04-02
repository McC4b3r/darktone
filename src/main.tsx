import ReactDOM from "react-dom/client";
import App from "./App";
import { getRuntimeMode } from "./lib/tauri";
import { PlaybackSmokeApp } from "./smoke/PlaybackSmokeApp";
import "./styles/app.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);

void getRuntimeMode()
  .then((runtimeMode) => {
    if (runtimeMode.kind === "playbackSmoke") {
      root.render(<PlaybackSmokeApp config={runtimeMode.config} />);
      return;
    }

    root.render(<App />);
  })
  .catch(() => {
    root.render(<App />);
  });
