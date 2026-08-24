import { Fragment } from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@workspace/ui/components/breadcrumb";

import type { RunNode } from "@/lib/runs";

type RunBreadcrumbProps = {
  node: RunNode;
  onSelect: (id: string) => void;
};

export function RunBreadcrumb({ node, onSelect }: RunBreadcrumbProps) {
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="min-w-0">
          <span className="truncate">{node.project.name}</span>
        </BreadcrumbItem>
        {node.ancestors.map((ancestor) => (
          <Fragment key={ancestor.id}>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbLink asChild className="min-w-0">
                <button type="button" className="truncate" onClick={() => onSelect(ancestor.id)}>
                  {ancestor.name}
                </button>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </Fragment>
        ))}
        <BreadcrumbSeparator />
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="truncate">{node.run.name}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
