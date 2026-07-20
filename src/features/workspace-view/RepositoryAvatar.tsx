import { FolderGit2Icon, UserRoundIcon } from "lucide-react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

const githubRepositoryPattern =
  /^([A-Za-z0-9_.-]{1,39})\/[A-Za-z0-9_.-]{1,100}$/

function githubOwner(repository: string | undefined): string | null {
  return repository?.match(githubRepositoryPattern)?.[1] ?? null
}

function githubAvatarUrl(owner: string): string {
  return `https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?size=48`
}

export function RepositoryAvatar({
  githubRepository,
  size = "sm",
}: {
  readonly githubRepository: string | undefined
  readonly size?: "default" | "sm" | "lg"
}) {
  const owner = githubOwner(githubRepository)

  return (
    <Avatar
      aria-hidden="true"
      data-github-owner={owner ?? undefined}
      data-repository-avatar={owner === null ? "local" : "github"}
      size={size}
    >
      {owner === null ? null : (
        <AvatarImage
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          src={githubAvatarUrl(owner)}
        />
      )}
      <AvatarFallback className="[&>svg]:size-3">
        {owner === null ? <FolderGit2Icon /> : <UserRoundIcon />}
      </AvatarFallback>
    </Avatar>
  )
}
