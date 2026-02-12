FROM denoland/deno:debian
RUN apt-get update && apt-get install -y --no-install-recommends curl rsync openssh-client && rm -rf /var/lib/apt/lists/*
COPY swamp /usr/local/bin/swamp
RUN chmod +x /usr/local/bin/swamp
