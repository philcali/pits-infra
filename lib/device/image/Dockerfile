FROM public.ecr.aws/lambda/provided:al2
ARG mediainfov="v22.06"
ARG zenlibv="v0.4.39"

# Deps for awscli, ffmpeg
RUN yum install -y \
    unzip \
    tar \
    xz \
    jq

# Deps for mediainfo
RUN yum install -y \
    git \
    automake \
    autoconf \
    libtool \
    pkgconfig \
    make \
    gcc-c++ \
    zlib-devel

RUN git clone https://github.com/MediaArea/ZenLib.git \
    && cd ZenLib \
    && git checkout ${zenlibv} \
    && cd Project/GNU/Library \
    && ./autogen.sh \
    && ./configure --enable-static \
    && make \
    && make install

RUN git clone https://github.com/MediaArea/MediaInfoLib.git \
    && cd MediaInfoLib \
    && git checkout ${mediainfov} \
    && cd Project/GNU/Library \
    && ./autogen.sh \
    && ./configure --enable-static \
    && make \
    && make install

RUN git clone https://github.com/MediaArea/MediaInfo.git \
    && cd MediaInfo \
    && git checkout ${mediainfov} \
    && cd Project/GNU/CLI \
    && ./autogen.sh \
    && ./configure --enable-shared \
    && make \
    && make install

RUN rm -rf ZenLib \
    && rm -rf MediaInfoLib \
    && rm -rf MediaInfo

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
