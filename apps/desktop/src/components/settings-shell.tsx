import { createContext, useContext, useState, type ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Badge } from "@workspace/ui/components/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@workspace/ui/components/item";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@workspace/ui/components/sidebar";

export type Section = { value: string; label: string };

const Showing = createContext<string | undefined>(undefined);

type SettingsShellProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  /** Sits above the section list, where a modal names what it is settling. */
  lead?: ReactNode;
  sections: Section[];
  children: ReactNode;
};

/** The settings modal: sections down the left, one scrolling pane on the right. */
export function SettingsShell({
  open,
  onClose,
  title,
  description,
  lead,
  sections,
  children,
}: SettingsShellProps) {
  const [showing, setShowing] = useState(sections[0]?.value);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="h-120 max-h-[calc(100svh---spacing(8))] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <SidebarProvider
          className="h-full min-h-0 items-start"
          style={{ "--sidebar-width": "11rem" } as React.CSSProperties}
        >
          <Sidebar collapsible="none" className="border-r">
            <SidebarContent>
              <SidebarGroup>
                {lead}
                <SidebarGroupContent>
                  <SidebarMenu>
                    {sections.map((section) => (
                      <SidebarMenuItem key={section.value}>
                        <SidebarMenuButton
                          isActive={section.value === showing}
                          onClick={() => setShowing(section.value)}
                        >
                          {section.label}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <Showing.Provider value={showing}>{children}</Showing.Provider>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}

type SettingsPaneProps = {
  value: string;
  heading: string;
  trouble?: string | undefined;
  children: ReactNode;
};

export function SettingsPane({ value, heading, trouble, children }: SettingsPaneProps) {
  const showing = useContext(Showing);
  if (showing !== value) return null;

  return (
    <main className="min-w-0 flex-1 overflow-y-auto p-6 text-sm">
      <h2 className="mb-4 font-semibold">{heading}</h2>
      {trouble === undefined ? null : (
        <Alert variant="destructive" className="mb-4">
          <TriangleAlertIcon />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{trouble}</AlertDescription>
        </Alert>
      )}
      {children}
    </main>
  );
}

export type Definition = {
  key: string;
  name: string;
  /** What the name alone leaves out, such as the role an adapter fills. */
  note?: string;
  detail: string | undefined;
  scope: string;
};

/** What a catalog holds of one kind, each row saying which catalog it came from. */
export function DefinitionList({ items, empty }: { items: Definition[]; empty: string }) {
  if (items.length === 0) {
    return <p className="text-muted-foreground">{empty}</p>;
  }

  return (
    <ItemGroup className="gap-0">
      {items.map((item) => (
        <Item key={item.key} size="sm" className="px-0">
          <ItemContent>
            <ItemTitle>
              {item.name}
              {item.note === undefined ? null : (
                <span className="font-normal text-muted-foreground">{item.note}</span>
              )}
            </ItemTitle>
            <ItemDescription>{item.detail}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Badge variant="secondary">{item.scope}</Badge>
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
}
