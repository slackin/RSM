import type { OrganizePlanResponse } from "@rsm/shared";

interface Props {
  plan: OrganizePlanResponse | null;
}

export function OrganizePreview({ plan }: Props) {
  return (
    <section>
      <h2>Organize Plan Preview</h2>
      <ul>
        {(plan?.items ?? []).slice(0, 10).map((item) => (
          <li key={item.source}>
            {item.source}{" -> "}{item.destination}
          </li>
        ))}
      </ul>
    </section>
  );
}
