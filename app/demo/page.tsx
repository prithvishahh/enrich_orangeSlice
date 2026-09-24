import EnrichApp from "@/components/EnrichApp";
import { DEMO_DOMAINS } from "@/lib/enrich/demo";

export const metadata = { title: "Enrich · Demo" };

export default function Demo() {
  return <EnrichApp initialDomains={DEMO_DOMAINS} title="Demo · YC B2B SaaS" />;
}
