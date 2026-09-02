import { Item, ItemContent, ItemMedia, ItemTitle } from "@workspace/ui/components/item";
import { Spinner } from "@workspace/ui/components/spinner";

/** The row that stands in while an engine run reads what a folder can reach. */
export function ReadingCatalogs({ label = "Reading the catalogs" }: { label?: string }) {
  return (
    <Item size="sm">
      <ItemMedia>
        <Spinner />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="font-normal text-muted-foreground">{label}</ItemTitle>
      </ItemContent>
    </Item>
  );
}
