FROM public.ecr.aws/lambda/provided:al2

RUN yum install -y \
    unzip \
    tar \
    xz \
    jq

RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm awscliv2.zip

RUN curl "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" -o "ffmpeg.tar.xz" \
    && mkdir ffmpeg \
    && tar -xvf ffmpeg.tar.xz --strip-components=1 -C ffmpeg \
    && rm -f ffmpeg.tar.xz \
    && mv ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
    && rm -rf ffmpeg

COPY bootstrap ${LAMBDA_RUNTIME_DIR}
COPY function.sh ${LAMBDA_TASK_ROOT}

CMD [ "function.handler" ]