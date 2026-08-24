import { Item, ItemContent, ItemMedia, ItemTitle } from "@workspace/ui/components/item";
import { Spinner } from "@workspace/ui/components/spinner";

/** The row that stands in while an engine run reads what a folder can reach. */
export function ReadingCatalogs() {
  return (
    <Item size="sm">
      <ItemMedia>
        <Spinner />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="font-normal text-muted-foreground">Reading the catalogs</ItemTitle>
      </ItemContent>
    </Item>
  );
}
