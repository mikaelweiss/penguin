import { useEffect, useRef, useState } from "react";

import { onFilesChanged, reviewRoot, type ReviewRoot } from "@/lib/files";

/** The work tree the selected run reviews. undefined until the answer lands. */
export function useReviewRoot(dir: string | undefined): ReviewRoot | undefined {
  const [root, setRoot] = useState<ReviewRoot | undefined>(undefined);
  const [asked, setAsked] = useState(0);
  const latest = useRef(0);
  const here = useRef<string | undefined>(undefined);

  useEffect(() => {
    setRoot(undefined);
    here.current = undefined;
  }, [dir]);

  useEffect(() => {
    if (dir === undefined) return;
    const ticket = latest.current + 1;
    latest.current = ticket;
    let dropped = false;
    reviewRoot(dir).then(
      (found) => {
        if (dropped || latest.current !== ticket) return;
        here.current = found.root;
        setRoot(found);
      },
      () => {},
    );
    return () => {
      dropped = true;
    };
  }, [dir, asked]);

  // A checkout moves the branch, and the branch is part of the answer.
  useEffect(() => {
    const stopping = onFilesChanged((changed) => {
      if (changed.git && changed.root === here.current) setAsked((count) => count + 1);
    });
    return () => {
      stopping.then((stop) => stop()).catch(() => {});
    };
  }, []);

  return root;
}
