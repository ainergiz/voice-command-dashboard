interface AudioLevelMeterProps {
  level: number; // 0.0 to 1.0 RMS
}

export function AudioLevelMeter({ level }: AudioLevelMeterProps) {
  // Scale the level for better visual representation
  // RMS values are typically low, so we amplify and clamp
  const displayLevel = Math.min(1, level * 5);
  const widthPercent = Math.round(displayLevel * 100);

  return (
    <div className="audio-meter">
      <div
        className="audio-meter__fill"
        style={{ width: `${widthPercent}%` }}
      />
    </div>
  );
}
