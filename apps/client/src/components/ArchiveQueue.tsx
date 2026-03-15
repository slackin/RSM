interface Props {
  lastJobId: string | null;
}

export function ArchiveQueue({ lastJobId }: Props) {
  return (
    <section>
      <h2>Archive Queue</h2>
      <p>{lastJobId ? `Last queued archive job: ${lastJobId}` : "No archive jobs queued yet."}</p>
    </section>
  );
}
