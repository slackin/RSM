import { useState } from "react";

interface Props {
  value: string;
  onChange: (next: string) => void;
  versionWarning?: string | null;
}

export function ConnectionSettings({ value, onChange, versionWarning }: Props) {
  const [draft, setDraft] = useState(value);

  return (
    <section>
      <h2>Connection</h2>
      <label>
        Service URL
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="http://host:8787"
        />
      </label>
      <button onClick={() => onChange(draft)}>Apply</button>
      {versionWarning && (
        <p style={{ color: "#b85c00", background: "#fff3cd", border: "1px solid #f0c040", borderRadius: 4, padding: "0.4rem 0.6rem", marginTop: "0.5rem" }}>
          ⚠ {versionWarning}
        </p>
      )}
    </section>
  );
}
